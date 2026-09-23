"""Mediqo demo seed script (Step 3).

Populates PostgreSQL with a controlled set of FICTIONAL demo doctors and
demo reviews so the matching flow (location + problem -> doctors) can be
demonstrated end to end.

Data policy:
- Every inserted doctor and every inserted review has is_demo=True.
- Reviews are fictional sample content; the frontend must label them as
  demo/sample reviews — never as genuine patient feedback.
- Every person, clinic and credential is FICTIONAL; no real individual's
  personal information is used anywhere in this file.
- Coordinates are approximate, plausible positions around real city centers
  (source of truth: CITY_CENTERS in app/services/location_service.py) so
  distance calculations are meaningful across India.
- The dataset is deliberately structured so different cities expose
  different specialty mixes — Lucknow is the deepest market, metro cities
  get broad-but-not-identical coverage, and Gorakhpur / the Kerala cities
  get smaller distinct sets. This gives the matching engine meaningful
  geographic differentiation (a Mumbai user must never see the same
  doctors as a Lucknow user).

Repeatability / non-destructiveness:
- `seed_demo_data()` (used by the API on startup) inserts the full dataset
  only when the database has NO demo doctors at all (first boot).
- `top_up_demo_data()` is the safe, deterministic upgrade path: it inserts
  only doctors whose (name, city) pair is not yet present, so an existing
  database (e.g. production) gains the new cities/specialties without ever
  deleting or modifying existing rows.

Run from the backend/ directory:
    .venv/Scripts/python.exe -m app.seed
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

# Allow `python app/seed.py` in addition to `python -m app.seed`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import SessionLocal, ensure_schema
from app.models import Doctor, Review

# ---------------------------------------------------------------------------
# Availability templates (JSONB contract: day key -> list of [start, end])
# Deliberately varied so the matching engine can differentiate doctors by
# "available today", morning vs evening, and closed days. Every weekday
# Monday-Saturday has several doctors OFF in this set.
# ---------------------------------------------------------------------------
AVAILABILITY_PATTERNS: list[dict[str, list[list[str]]]] = [
    {   # P0 — weekday evenings + Saturday morning
        "mon": [["16:00", "20:00"]], "tue": [["16:00", "20:00"]],
        "wed": [["16:00", "20:00"]], "thu": [["16:00", "20:00"]],
        "fri": [["16:00", "20:00"]], "sat": [["10:00", "14:00"]], "sun": [],
    },
    {   # P1 — weekday mornings + Saturday morning
        "mon": [["09:00", "13:00"]], "tue": [["09:00", "13:00"]],
        "wed": [["09:00", "13:00"]], "thu": [["09:00", "13:00"]],
        "fri": [["09:00", "13:00"]], "sat": [["09:00", "12:00"]], "sun": [],
    },
    {   # P2 — both shifts on weekdays + Saturday morning
        "mon": [["09:00", "12:30"], ["17:00", "20:00"]],
        "tue": [["09:00", "12:30"], ["17:00", "20:00"]],
        "wed": [["09:00", "12:30"], ["17:00", "20:00"]],
        "thu": [["09:00", "12:30"], ["17:00", "20:00"]],
        "fri": [["09:00", "12:30"], ["17:00", "20:00"]],
        "sat": [["10:00", "13:00"]], "sun": [],
    },
    {   # P3 — weekday evenings + Sunday morning clinic (Saturday off)
        "mon": [["17:00", "21:00"]], "tue": [["17:00", "21:00"]],
        "wed": [["17:00", "21:00"]], "thu": [["17:00", "21:00"]],
        "fri": [["17:00", "21:00"]], "sat": [], "sun": [["10:00", "13:00"]],
    },
    {   # P4 — Tue off; morning/afternoon split
        "mon": [["10:00", "13:00"]], "tue": [],
        "wed": [["10:00", "13:00"]], "thu": [["17:00", "20:00"]],
        "fri": [["10:00", "13:00"]], "sat": [["10:00", "12:30"]], "sun": [],
    },
    {   # P5 — open every day (mornings)
        "mon": [["10:00", "13:00"]], "tue": [["10:00", "13:00"]],
        "wed": [["10:00", "13:00"]], "thu": [["10:00", "13:00"]],
        "fri": [["10:00", "13:00"]], "sat": [["10:00", "13:00"]],
        "sun": [["10:00", "12:00"]],
    },
    {   # P6 — Tuesday–Sunday evenings (Monday off)
        "mon": [], "tue": [["18:00", "21:00"]], "wed": [["18:00", "21:00"]],
        "thu": [["18:00", "21:00"]], "fri": [["18:00", "21:00"]],
        "sat": [["18:00", "21:00"]], "sun": [["18:00", "21:00"]],
    },
    {   # P7 — both shifts, Monday–Saturday
        "mon": [["09:00", "12:00"], ["18:00", "20:00"]],
        "tue": [["09:00", "12:00"], ["18:00", "20:00"]],
        "wed": [["09:00", "12:00"], ["18:00", "20:00"]],
        "thu": [["09:00", "12:00"], ["18:00", "20:00"]],
        "fri": [["09:00", "12:00"], ["18:00", "20:00"]],
        "sat": [["09:00", "12:00"], ["18:00", "20:00"]], "sun": [],
    },
    {   # P8 — Wednesday & Saturday off
        "mon": [["17:00", "20:30"]], "tue": [["17:00", "20:30"]],
        "wed": [], "thu": [["17:00", "20:30"]], "fri": [["17:00", "20:30"]],
        "sat": [], "sun": [],
    },
    {   # P9 — Wednesday, Thursday, Friday, Saturday off; mornings only
        "mon": [["09:30", "12:30"]], "tue": [["09:30", "12:30"]],
        "wed": [], "thu": [], "fri": [],
        "sat": [], "sun": [],
    },
]

# ---------------------------------------------------------------------------
# Demo doctor dataset — the single source of truth for all demo doctors.
#
# Tuple shape (identical to the original Step 3 format):
#   (name, specialization, qualification, experience_years, languages,
#    consultation_fee, clinic_name, address, city, latitude, longitude)
#
# All of it is FICTIONAL. Cities are spread across India with deliberate
# specialty mixes (never every specialty everywhere) so the matching
# engine produces meaningfully different results per city. Coordinates are
# plausible locality positions near each city's center.
# ---------------------------------------------------------------------------
DEMO_DOCTORS: list[tuple[str, str, str, int, list[str], int, str, str, str, float, float]] = [
    # ======================= LUCKNOW (deep market) =======================
    # --- General Physician (5) ---
    ("Dr. Rajesh Verma", "General Physician", "MBBS", 12, ["Hindi", "English"], 400,
     "Verma Family Clinic", "Shop 14, Vikas Khand-1, Gomti Nagar", "Lucknow", 26.8565, 80.9880),
    ("Dr. Sunita Mishra", "General Physician", "MBBS, MD (Family Medicine)", 9, ["Hindi", "English"], 500,
     "Mishra Health Point", "Near Halwasiya Court, Hazratganj", "Lucknow", 26.8455, 80.9440),
    ("Dr. Imran Ahmad", "General Physician", "MBBS", 6, ["Hindi", "English", "Urdu"], 350,
     "Noor Polyclinic", "Chowk Bazaar Road, Chowk", "Lucknow", 26.8645, 80.9020),
    ("Dr. Pooja Srivastava", "General Physician", "MBBS, DNB (Family Medicine)", 7, ["Hindi", "English"], 450,
     "Arogya Clinic", "Sector 14, Indira Nagar", "Lucknow", 26.8955, 80.9735),
    ("Dr. Devendra Yadav", "General Physician", "MBBS", 15, ["Hindi"], 300,
     "Gramin Seva Clinic", "Kakori Road", "Lucknow", 26.8720, 80.7950),
    # --- Cardiologist (4) ---
    ("Dr. Vikram Sethi", "Cardiologist", "MBBS, MD, DM (Cardiology)", 18, ["English", "Hindi"], 1200,
     "HeartCare Clinic", "Summit Building, Vibhuti Khand", "Lucknow", 26.8560, 81.0095),
    ("Dr. Nandini Rao", "Cardiologist", "MBBS, MD, DNB (Cardiology)", 11, ["English", "Hindi"], 900,
     "CardioPlus Clinic", "Mahanagar Extension", "Lucknow", 26.8745, 80.9520),
    ("Dr. Ashok Bajpai", "Cardiologist", "MBBS, MD, DM (Cardiology)", 22, ["Hindi", "English"], 1500,
     "Bajpai Heart Institute", "Rana Pratap Marg, Hazratganj", "Lucknow", 26.8480, 80.9410),
    ("Dr. Sameer Khan", "Cardiologist", "MBBS, MD, DM (Cardiology)", 9, ["Hindi", "English", "Urdu"], 800,
     "Sehat Heart Centre", "Naka Hindola", "Lucknow", 26.8445, 80.9155),
    # --- Dermatologist (4) ---
    ("Dr. Ritika Chopra", "Dermatologist", "MBBS, MD (Dermatology)", 8, ["English", "Hindi"], 700,
     "GlowDerm Clinic", "Vikalp Khand, Gomti Nagar", "Lucknow", 26.8520, 80.9980),
    ("Dr. Manish Agarwal", "Dermatologist", "MBBS, DVD", 14, ["Hindi", "English"], 600,
     "Skin Solutions", "Sector B, Aliganj", "Lucknow", 26.8905, 80.9380),
    ("Dr. Farah Naaz", "Dermatologist", "MBBS, MD (Dermatology)", 6, ["Hindi", "Urdu", "English"], 500,
     "Noor Skin & Hair Clinic", "Aminabad", "Lucknow", 26.8490, 80.9200),
    ("Dr. Kavita Joshi", "Dermatologist", "MBBS, MD (Dermatology)", 12, ["English", "Hindi"], 800,
     "DermaCare Studio", "Golf City Road", "Lucknow", 26.7905, 81.0040),
    # --- Dentist (5) ---
    ("Dr. Rohan Malhotra", "Dentist", "BDS, MDS", 10, ["English", "Hindi"], 500,
     "Smile Studio Dental", "Park Road, Hazratganj", "Lucknow", 26.8460, 80.9435),
    ("Dr. Neha Bhatnagar", "Dentist", "BDS, MDS (Orthodontics)", 7, ["Hindi", "English"], 450,
     "Perfect Smile Dental Care", "Sector C, Aliganj", "Lucknow", 26.8915, 80.9415),
    ("Dr. Sadiq Ali", "Dentist", "BDS", 9, ["Hindi", "Urdu", "English"], 300,
     "Ali Dental Clinic", "Chowk", "Lucknow", 26.8650, 80.9005),
    ("Dr. Shalini Gupta", "Dentist", "BDS, MDS (Periodontics)", 13, ["English", "Hindi"], 600,
     "GumCare Dental Hub", "Indira Nagar", "Lucknow", 26.8970, 80.9700),
    ("Dr. Aakash Jain", "Dentist", "BDS", 4, ["Hindi", "English"], 250,
     "Jai Dental Point", "Rajajipuram", "Lucknow", 26.8385, 80.8810),
    # --- Orthopedic (4) ---
    ("Dr. Harish Chandra", "Orthopedic", "MBBS, MS (Orthopaedics)", 20, ["Hindi", "English"], 900,
     "BoneJoint Clinic", "Charbagh", "Lucknow", 26.8315, 80.9215),
    ("Dr. Nikhil Sinha", "Orthopedic", "MBBS, MS (Orthopaedics)", 8, ["English", "Hindi"], 700,
     "OrthoFirst Clinic", "Vibhuti Khand, Gomti Nagar", "Lucknow", 26.8570, 81.0090),
    ("Dr. Meenakshi Pandey", "Orthopedic", "MBBS, DNB (Orthopaedics)", 11, ["Hindi", "English"], 650,
     "Aastha Ortho Centre", "Mahanagar", "Lucknow", 26.8750, 80.9480),
    ("Dr. Tanveer Husain", "Orthopedic", "MBBS, MS (Orthopaedics)", 16, ["Hindi", "Urdu", "English"], 850,
     "Apna Ortho OPD Clinic", "Aishbagh", "Lucknow", 26.8290, 80.9060),
    # --- Gastroenterologist (4) ---
    ("Dr. Aarav Sharma", "Gastroenterologist", "MBBS, MD, DM (Gastroenterology)", 8, ["English", "Hindi"], 600,
     "MediCare Clinic", "Sector 4, Gomti Nagar", "Lucknow", 26.8480, 81.0010),
    ("Dr. Lalit Mohan Saxena", "Gastroenterologist", "MBBS, MD, DM (Gastroenterology)", 17, ["Hindi", "English"], 1000,
     "Saxena Gut & Liver Clinic", "Hazratganj", "Lucknow", 26.8475, 80.9420),
    ("Dr. Isha Trivedi", "Gastroenterologist", "MBBS, MD, DNB (Gastroenterology)", 5, ["English", "Hindi"], 450,
     "Trivedi Digestive Care", "Alambagh", "Lucknow", 26.8070, 80.9010),
    ("Dr. Mohd. Rehan", "Gastroenterologist", "MBBS, MD, DM (Gastroenterology)", 12, ["Hindi", "English", "Urdu"], 750,
     "Rehan Gastro Clinic", "Kaiserbagh", "Lucknow", 26.8520, 80.9310),
    # --- ENT Specialist (3) ---
    ("Dr. Girish Nigam", "ENT Specialist", "MBBS, MS (ENT)", 14, ["Hindi", "English"], 600,
     "Nigam ENT Centre", "Nirala Nagar", "Lucknow", 26.8710, 80.9290),
    ("Dr. Anjali Dubey", "ENT Specialist", "MBBS, MS (ENT)", 6, ["English", "Hindi"], 450,
     "HearClear ENT Clinic", "Jankipuram", "Lucknow", 26.9140, 80.9410),
    ("Dr. Faizan Siddiqui", "ENT Specialist", "MBBS, DNB (ENT)", 10, ["Hindi", "Urdu", "English"], 550,
     "City ENT Care", "Aminabad", "Lucknow", 26.8485, 80.9185),
    # --- Pediatrician (4) ---
    ("Dr. Shalini Verma", "Pediatrician", "MBBS, MD (Paediatrics)", 13, ["Hindi", "English"], 600,
     "Little Steps Child Clinic", "Indira Nagar", "Lucknow", 26.8950, 80.9760),
    ("Dr. Rakesh Kumar Singh", "Pediatrician", "MBBS, DCH", 18, ["Hindi"], 400,
     "Bal Seva Clinic", "Kalyanpur", "Lucknow", 26.9125, 80.9240),
    ("Dr. Aditi Rastogi", "Pediatrician", "MBBS, MD (Paediatrics)", 7, ["English", "Hindi"], 550,
     "KidsFirst Clinic", "Vikas Khand, Gomti Nagar", "Lucknow", 26.8555, 80.9905),
    ("Dr. Javed Ansari", "Pediatrician", "MBBS, DNB (Paediatrics)", 9, ["Hindi", "Urdu", "English"], 500,
     "Ansari Child Care", "Chowk", "Lucknow", 26.8635, 80.9010),
    # --- Gynecologist (3) ---
    ("Dr. Usha Rani", "Gynecologist", "MBBS, MS (Obstetrics & Gynaecology)", 16, ["Hindi", "English"], 700,
     "Janani Maternity Clinic", "Lohia Path, Hazratganj", "Lucknow", 26.8500, 80.9350),
    ("Dr. Kavita Bajpai", "Gynecologist", "MBBS, DGO", 9, ["Hindi", "English"], 600,
     "MatriCare Clinic", "Sector 10, Indira Nagar", "Lucknow", 26.8930, 80.9770),
    ("Dr. Shabana Parveen", "Gynecologist", "MBBS, MS (Obstetrics & Gynaecology)", 12, ["Hindi", "Urdu", "English"], 650,
     "Nida Women's Clinic", "Monanganj Road", "Lucknow", 26.8560, 80.9100),
    # --- Neurologist (3) ---
    ("Dr. Prakash Nath", "Neurologist", "MBBS, MD, DM (Neurology)", 19, ["English", "Hindi"], 1300,
     "NeuroWell Clinic", "Hazratganj", "Lucknow", 26.8450, 80.9450),
    ("Dr. Shruti Kaul", "Neurologist", "MBBS, MD, DM (Neurology)", 10, ["English", "Hindi"], 1000,
     "Kaul Neuro Centre", "Gomti Nagar", "Lucknow", 26.8495, 81.0030),
    ("Dr. Waseem Ahmad", "Neurologist", "MBBS, MD, DNB (Neurology)", 8, ["Hindi", "Urdu", "English"], 800,
     "Rehmat Neuro Clinic", "Thakurganj", "Lucknow", 26.8580, 80.8960),
    # --- Ophthalmologist (4) ---
    ("Dr. Suresh Gupta", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 21, ["Hindi", "English"], 700,
     "Drishti Eye Clinic", "Mahanagar", "Lucknow", 26.8760, 80.9530),
    ("Dr. Pallavi Srivastava", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 9, ["English", "Hindi"], 600,
     "Vision Point Eye Care", "Aliganj", "Lucknow", 26.8910, 80.9420),
    ("Dr. Md. Faisal", "Ophthalmologist", "MBBS, DOMS", 7, ["Hindi", "Urdu", "English"], 450,
     "Faisal Eye Hospital OPD", "Kaiserbagh", "Lucknow", 26.8510, 80.9300),
    ("Dr. Deepa Nair", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 12, ["English", "Hindi"], 750,
     "Nair Eye Studio", "South City, Telibagh", "Lucknow", 26.7760, 80.9340),

    # ================== Nearby cities (small satellite sets) ==================
    ("Dr. Anupam Dwivedi", "General Physician", "MBBS", 10, ["Hindi", "English"], 350,
     "Dwivedi Clinic", "Civil Lines", "Kanpur", 26.4520, 80.3310),
    ("Dr. Yash Tyagi", "Orthopedic", "MBBS, MS (Orthopaedics)", 12, ["Hindi", "English"], 700,
     "Tyagi Bone & Joint Clinic", "Mall Road", "Kanpur", 26.4620, 80.3490),
    ("Dr. Sushma Tiwari", "Pediatrician", "MBBS, MD (Paediatrics)", 11, ["Hindi", "English"], 450,
     "Tiwari Child Clinic", "Hospital Road", "Unnao", 26.5480, 80.3650),
    ("Dr. Sachin Dixit", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 14, ["Hindi", "English"], 500,
     "Dixit Eye Hospital", "Station Road", "Sitapur", 27.1750, 80.6820),

    # ======================= GORAKHPUR (distinct, small) =======================
    ("Dr. Shivam Tiwari", "General Physician", "MBBS", 9, ["Hindi", "Bhojpuri", "English"], 300,
     "Tarang Health Centre", "Civil Lines", "Gorakhpur", 26.7650, 83.3700),
    ("Dr. Anand Prakash", "General Physician", "MBBS, MD (General Medicine)", 14, ["Hindi", "English"], 400,
     "Prakash Clinic", "Bank Road", "Gorakhpur", 26.7550, 83.3800),
    ("Dr. Kalpana Devi", "Pediatrician", "MBBS, DCH", 11, ["Hindi", "English"], 350,
     "Nanhe Kadam Child Clinic", "Rapti Nagar", "Gorakhpur", 26.7700, 83.3650),
    ("Dr. Brijesh Yadav", "Orthopedic", "MBBS, MS (Orthopaedics)", 13, ["Hindi", "English"], 600,
     "Sabal Bone & Joint Clinic", "Betting Tola", "Gorakhpur", 26.7500, 83.3900),
    ("Dr. Nazia Khatoon", "ENT Specialist", "MBBS, MS (ENT)", 8, ["Hindi", "Urdu", "English"], 450,
     "Sur ENT Care", "Golghar", "Gorakhpur", 26.7750, 83.3780),
    ("Dr. Ranjana Srivastava", "Gynecologist", "MBBS, MS (Obstetrics & Gynaecology)", 15, ["Hindi", "English"], 550,
     "Shubh Maternity Home", "Mohaddipur", "Gorakhpur", 26.7450, 83.3600),
    ("Dr. Prashant Upadhyay", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 10, ["Hindi", "English"], 500,
     "Rapti Eye Care", "Gorakhnath Road", "Gorakhpur", 26.7480, 83.3850),

    # ========================= DELHI (broad metro set) =========================
    ("Dr. Karan Malhotra", "General Physician", "MBBS, MD (Internal Medicine)", 10, ["English", "Hindi"], 700,
     "Metro Family Clinic", "Connaught Place", "Delhi", 28.6200, 77.2150),
    ("Dr. Priya Chawla", "General Physician", "MBBS", 6, ["Hindi", "English", "Punjabi"], 550,
     "CityCare Polyclinic", "Karol Bagh", "Delhi", 28.6050, 77.2050),
    ("Dr. Arvind Salaria", "Cardiologist", "MBBS, MD, DM (Cardiology)", 17, ["English", "Hindi"], 1400,
     "Capital Heart Institute", "Tilak Marg", "Delhi", 28.6180, 77.2020),
    ("Dr. Shefali Kapoor", "Dermatologist", "MBBS, MD (Dermatology)", 9, ["English", "Hindi"], 900,
     "Urban Skin Clinic", "Greater Kailash", "Delhi", 28.6280, 77.2190),
    ("Dr. Varun Sabharwal", "Dentist", "BDS, MDS (Prosthodontics)", 11, ["English", "Hindi", "Punjabi"], 800,
     "Smile Craft Dental Studio", "South Extension", "Delhi", 28.6100, 77.2300),
    ("Dr. Nisha Khurana", "Orthopedic", "MBBS, MS (Orthopaedics)", 14, ["Hindi", "English"], 1000,
     "Motion Ortho Clinic", "East of Kailash", "Delhi", 28.6350, 77.2250),
    ("Dr. Sameer Wadhwa", "Pediatrician", "MBBS, MD (Paediatrics)", 12, ["English", "Hindi"], 750,
     "Tiny Tots Child Care", "Rajouri Garden", "Delhi", 28.5950, 77.1900),
    ("Dr. Geeta Vashisht", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 13, ["Hindi", "English"], 800,
     "Delhi Eye Centre", "Daryaganj", "Delhi", 28.6400, 77.2000),

    # ======================== MUMBAI (broad metro set) ========================
    ("Dr. Aditya Deshpande", "General Physician", "MBBS", 8, ["Marathi", "Hindi", "English"], 600,
     "Marine Drive Family Practice", "Churchgate", "Mumbai", 19.0800, 72.8700),
    ("Dr. Shalaka Jadhav", "General Physician", "MBBS, MD (Family Medicine)", 12, ["Marathi", "Hindi", "English"], 700,
     "Sahyadri Health Point", "Dadar", "Mumbai", 19.0700, 72.8900),
    ("Dr. Rakesh Nair", "Cardiologist", "MBBS, MD, DM (Cardiology)", 19, ["English", "Hindi", "Malayalam"], 1600,
     "Harbour Heart Institute", "Bandra East", "Mumbai", 19.0850, 72.8950),
    ("Dr. Sneha Kulkarni", "Dermatologist", "MBBS, MD (Dermatology)", 7, ["Marathi", "English", "Hindi"], 950,
     "Radiant Skin Studio", "Andheri West", "Mumbai", 19.0750, 72.8650),
    ("Dr. Farhan Shaikh", "Dentist", "BDS", 9, ["Hindi", "English", "Marathi"], 600,
     "Pearl Dental Clinic", "Mohammad Ali Road", "Mumbai", 19.0900, 72.8800),
    ("Dr. Girish Oak", "Orthopedic", "MBBS, MS (Orthopaedics)", 21, ["Marathi", "Hindi", "English"], 1200,
     "Sankalp Bone & Joint Clinic", "Sion", "Mumbai", 19.0650, 72.8750),

    # ========================== PUNE (small metro set) =========================
    ("Dr. Manasi Deshmukh", "General Physician", "MBBS, MD (General Medicine)", 11, ["Marathi", "English", "Hindi"], 550,
     "Deccan Family Clinic", "FC Road", "Pune", 18.5250, 73.8500),
    ("Dr. Prasad Kulkarni", "Cardiologist", "MBBS, MD, DNB (Cardiology)", 13, ["Marathi", "English", "Hindi"], 1100,
     "Pune Heart Care", "Shivajinagar", "Pune", 18.5150, 73.8650),
    ("Dr. Rucha Joshi", "Dentist", "BDS, MDS (Endodontics)", 8, ["Marathi", "Hindi", "English"], 500,
     "Arya Dental Studio", "Kothrud", "Pune", 18.5300, 73.8700),
    ("Dr. Sameer Bhandari", "Orthopedic", "MBBS, MS (Orthopaedics)", 16, ["Marathi", "Hindi", "English"], 900,
     "Vyas Ortho Clinic", "Hadapsar", "Pune", 18.5100, 73.8450),

    # ======================= BENGALURU (broad metro set) =======================
    ("Dr. Ramesh Iyengar", "General Physician", "MBBS, MD (Internal Medicine)", 15, ["Kannada", "English", "Tamil"], 600,
     "Garden City Clinic", "Malleshwaram", "Bengaluru", 12.9750, 77.5900),
    ("Dr. Anitha Prakash", "General Physician", "MBBS", 7, ["Kannada", "English", "Telugu"], 500,
     "Jayanagar Family Practice", "Jayanagar", "Bengaluru", 12.9650, 77.6000),
    ("Dr. Kavya Reddy", "Dermatologist", "MBBS, MD (Dermatology)", 10, ["English", "Kannada", "Telugu"], 850,
     "Lumen Skin & Hair Clinic", "Indiranagar", "Bengaluru", 12.9800, 77.6050),
    ("Dr. Suresh Gowda", "Dentist", "BDS, MDS", 12, ["Kannada", "English"], 550,
     "Nandi Dental Care", "Basavanagudi", "Bengaluru", 12.9600, 77.5850),
    ("Dr. Arjun Rao", "Orthopedic", "MBBS, MS (Orthopaedics)", 18, ["English", "Kannada", "Telugu"], 1000,
     "Vidhana Ortho & Sports Clinic", "Ulsoor", "Bengaluru", 12.9900, 77.5950),
    ("Dr. Lakshmi Srinivasan", "Pediatrician", "MBBS, MD (Paediatrics)", 14, ["Tamil", "Kannada", "English"], 650,
     "Chirpy Kids Clinic", "HSR Layout", "Bengaluru", 12.9550, 77.6050),
    ("Dr. Divya Shetty", "Gynecologist", "MBBS, MS (Obstetrics & Gynaecology)", 11, ["Kannada", "English", "Tulu"], 800,
     "Amruta Women's Clinic", "Banashankari", "Bengaluru", 12.9700, 77.6150),
    ("Dr. Naveen Kumar", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 9, ["Kannada", "English"], 700,
     "Netra Eye Studio", "Rajajinagar", "Bengaluru", 12.9850, 77.5800),

    # ======================== HYDERABAD (mid metro set) ========================
    ("Dr. Ananya Reddy", "General Physician", "MBBS, MD (General Medicine)", 10, ["Telugu", "English", "Hindi"], 500,
     "Deccan Family Clinic", "Abids", "Hyderabad", 17.3900, 78.4800),
    ("Dr. Vikram Rao", "Cardiologist", "MBBS, MD, DM (Cardiology)", 20, ["English", "Telugu", "Hindi"], 1300,
     "Charminar Heart Institute", "King Koti", "Hyderabad", 17.3800, 78.4950),
    ("Dr. Sruthi Nandan", "Dentist", "BDS", 5, ["Telugu", "English"], 400,
     "Pearl Smile Dental", "Ameerpet", "Hyderabad", 17.3950, 78.4900),
    ("Dr. Jyothi Raghavan", "Gynecologist", "MBBS, DGO", 13, ["Telugu", "English", "Malayalam"], 700,
     "Srilekha Maternity Clinic", "Lakdikapul", "Hyderabad", 17.3750, 78.4750),
    ("Dr. Vinay Goud", "Gastroenterologist", "MBBS, MD, DM (Gastroenterology)", 12, ["Telugu", "English", "Hindi"], 800,
     "Prism Gut & Liver Care", "Nampally", "Hyderabad", 17.4000, 78.5000),

    # ========================= CHENNAI (mid metro set) =========================
    ("Dr. Murali Krishnan", "General Physician", "MBBS, MD (General Medicine)", 13, ["Tamil", "English"], 500,
     "Marina Family Clinic", "Triplicane", "Chennai", 13.0880, 80.2750),
    ("Dr. Saravanan Balu", "ENT Specialist", "MBBS, MS (ENT)", 15, ["Tamil", "English"], 700,
     "Kaveri ENT Care", "Egmore", "Chennai", 13.0780, 80.2650),
    ("Dr. Priyadarshini Rao", "Dermatologist", "MBBS, MD (Dermatology)", 8, ["Tamil", "English", "Telugu"], 750,
     "Coromandel Skin Clinic", "T. Nagar", "Chennai", 13.0900, 80.2600),
    ("Dr. Bala Murugan", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 17, ["Tamil", "English"], 650,
     "Chola Eye Hospital OPD", "Washermanpet", "Chennai", 13.0700, 80.2800),
    ("Dr. Nithya Sundaram", "Pediatrician", "MBBS, MD (Paediatrics)", 9, ["Tamil", "English"], 550,
     "Kutty Chellam Child Clinic", "Adyar", "Chennai", 13.0950, 80.2850),

    # ========================= KOLKATA (mid metro set) =========================
    ("Dr. Subhankar Dutta", "General Physician", "MBBS, MD (General Medicine)", 12, ["Bengali", "Hindi", "English"], 450,
     "Howrah Bridge Family Clinic", "Esplanade", "Kolkata", 22.5780, 88.3700),
    ("Dr. Rituparna Sen", "General Physician", "MBBS", 6, ["Bengali", "English"], 350,
     "Bagbazar Health Point", "Bagbazar", "Kolkata", 22.5680, 88.3550),
    ("Dr. Anirban Ghosh", "Cardiologist", "MBBS, MD, DM (Cardiology)", 16, ["Bengali", "English", "Hindi"], 1200,
     "Bengal Heart Institute", "Park Street", "Kolkata", 22.5850, 88.3600),
    ("Dr. Sarmila Bose", "ENT Specialist", "MBBS, DNB (ENT)", 11, ["Bengali", "English", "Hindi"], 600,
     "KaliGhat ENT Clinic", "Gariahat", "Kolkata", 22.5600, 88.3750),
    ("Dr. Madhurima Das", "Gynecologist", "MBBS, MS (Obstetrics & Gynaecology)", 14, ["Bengali", "English"], 700,
     "Sreemati Maternity Clinic", "Bhowanipore", "Kolkata", 22.5900, 88.3800),

    # ========================== JAIPUR (small set) ============================
    ("Dr. Mahesh Choudhary", "General Physician", "MBBS", 10, ["Hindi", "English"], 400,
     "Pink City Clinic", "MI Road", "Jaipur", 26.9180, 75.7950),
    ("Dr. Kiran Shekhawat", "Orthopedic", "MBBS, MS (Orthopaedics)", 12, ["Hindi", "English"], 750,
     "Aravali Bone & Joint Clinic", "C-Scheme", "Jaipur", 26.9080, 75.7800),
    ("Dr. Ritu Kanwar", "Dentist", "BDS, MDS (Orthodontics)", 7, ["Hindi", "English"], 450,
     "Heritage Smile Dental", "Malviya Nagar", "Jaipur", 26.9250, 75.7750),
    ("Dr. Lokesh Sharma", "Pediatrician", "MBBS, DCH", 9, ["Hindi", "English"], 400,
     "Nanhi Duniya Child Clinic", "Vaishali Nagar", "Jaipur", 26.9000, 75.8000),

    # ==================== KOCHI (Malayalam/English-oriented) ====================
    ("Dr. Arjun Menon", "General Physician", "MBBS", 9, ["Malayalam", "English", "Hindi"], 400,
     "Backwater Family Clinic", "Kochi Marine Drive", "Kochi", 9.9350, 76.2700),
    ("Dr. Lakshmi Nair", "General Physician", "MBBS, MD (Family Medicine)", 13, ["Malayalam", "English"], 500,
     "Palm Shore Polyclinic", "Kathrikadavu", "Kochi", 9.9250, 76.2600),
    ("Dr. Thomas Kurian", "Dentist", "BDS, MDS (Periodontics)", 11, ["Malayalam", "English"], 500,
     "Spice Coast Dental Care", "Kaloor", "Kochi", 9.9400, 76.2750),
    ("Dr. Meera Krishnan", "Pediatrician", "MBBS, MD (Paediatrics)", 10, ["Malayalam", "English", "Tamil"], 550,
     "Kuttikkan Child Clinic", "Palarivattom", "Kochi", 9.9200, 76.2800),
    ("Dr. Devika Pillai", "Gynecologist", "MBBS, MS (Obstetrics & Gynaecology)", 15, ["Malayalam", "English"], 650,
     "Udaya Maternity Clinic", "Tripunithura Road", "Kochi", 9.9450, 76.2650),
    ("Dr. Rahul Varma", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 12, ["Malayalam", "English"], 600,
     "Kerala Eye Studio", "Vyttila", "Kochi", 9.9150, 76.2550),

    # =============== THIRUVANANTHAPURAM (distinct small set) ===============
    ("Dr. Vinod Ravindran", "General Physician", "MBBS, MD (General Medicine)", 14, ["Malayalam", "English"], 450,
     "Sree Family Clinic", "Statue Junction", "Thiruvananthapuram", 8.5280, 76.9400),
    ("Dr. Anjali Mohan", "Dentist", "BDS", 6, ["Malayalam", "English"], 350,
     "Anantha Dental Care", "Public Library Road", "Thiruvananthapuram", 8.5200, 76.9300),
    ("Dr. Gopika Raj", "Ophthalmologist", "MBBS, DOMS", 8, ["Malayalam", "English"], 500,
     "Padma Eye Clinic", "Kesavadasapuram", "Thiruvananthapuram", 8.5320, 76.9450),
    ("Dr. Preethi Sivasankar", "Gynecologist", "MBBS, DGO", 12, ["Malayalam", "English", "Tamil"], 600,
     "Amma Maternity Clinic", "Pattom", "Thiruvananthapuram", 8.5150, 76.9250),
    ("Dr. Arun Nambiar", "Pediatrician", "MBBS, MD (Paediatrics)", 10, ["Malayalam", "English"], 500,
     "Onapookavan Child Clinic", "Vazhuthacaud", "Thiruvananthapuram", 8.5400, 76.9350),

    # ========================= KOZHIKODE (small set) =========================
    ("Dr. Faisal Rahman", "General Physician", "MBBS", 8, ["Malayalam", "English"], 350,
     "Malabar Family Clinic", "SM Street", "Kozhikode", 11.2630, 75.7850),
    ("Dr. Shahida Beegum", "ENT Specialist", "MBBS, MS (ENT)", 12, ["Malayalam", "English"], 500,
     "Kappad ENT Care", "Mavoor Road", "Kozhikode", 11.2540, 75.7750),
    ("Dr. Manjusha Warrier", "Dermatologist", "MBBS, MD (Dermatology)", 9, ["Malayalam", "English"], 600,
     "Beach Road Skin Clinic", "Near Kozhikode Beach", "Kozhikode", 11.2700, 75.7900),
]

# ---------------------------------------------------------------------------
# Bio templates per specialization (assigned round-robin within a specialty)
# ---------------------------------------------------------------------------
BIO_TEMPLATES: dict[str, list[str]] = {
    "General Physician": [
        "General physician managing everyday illnesses, preventive check-ups and long-term condition follow-ups for families.",
        "First-point consultation for fever, infections and lifestyle-related health concerns, with specialist referrals when needed.",
    ],
    "Cardiologist": [
        "Cardiologist focused on preventive heart care, blood pressure management and evaluation of cardiac symptoms.",
        "Heart specialist for chest-pain evaluation, hypertension follow-up and structured cardiac risk assessment.",
    ],
    "Dermatologist": [
        "Dermatologist treating acne, pigmentation, allergies and routine skin, hair and nail concerns.",
        "Skin specialist offering medical dermatology consultations with realistic, step-by-step treatment plans.",
    ],
    "Dentist": [
        "Dental surgeon for routine check-ups, fillings, cleanings and preventive dental care.",
        "Dentist with a gentle, patient-first approach to everyday dental problems.",
    ],
    "Orthopedic": [
        "Orthopaedic specialist for joint pain, back problems, fractures and sports-related injuries.",
        "Bone and joint specialist focused on non-surgical management first, surgery only when truly required.",
    ],
    "Gastroenterologist": [
        "Gastroenterologist evaluating acidity, digestive disorders and liver-related conditions.",
        "Digestive health specialist with a conservative, evidence-based treatment approach.",
    ],
    "ENT Specialist": [
        "ENT specialist for ear infections, sinus problems, throat pain and hearing concerns.",
        "Ear, nose and throat specialist covering both adults and children.",
    ],
    "Pediatrician": [
        "Paediatrician caring for newborns, childhood vaccinations and growth monitoring.",
        "Child health specialist focused on gentle, family-centred care.",
    ],
    "Gynecologist": [
        "Gynecologist caring for women through pregnancy, routine women's health check-ups and preventive care.",
        "Women's health specialist for menstrual concerns, antenatal care and family-planning consultations.",
    ],
    "Neurologist": [
        "Neurologist evaluating headaches, migraine, vertigo, seizures and nerve-related symptoms.",
        "Brain and nerve specialist with a structured, history-first diagnostic approach.",
    ],
    "Ophthalmologist": [
        "Ophthalmologist for vision testing, cataract evaluation and routine eye care.",
        "Eye specialist covering refraction, dry eye and routine diabetic eye check-ups.",
    ],
}

# ---------------------------------------------------------------------------
# Fictional demo doctors.
# Tuple: (name, specialization, qualification, experience_years, languages,
#         consultation_fee, clinic_name, address, city, latitude, longitude)
# Coordinates are approximate, plausible positions for Lucknow localities
# (plus a few doctors in nearby cities) — good enough for meaningful
# distance calculations in the matching engine.
# ---------------------------------------------------------------------------
# The full demo dataset (the name DOCTOR_ENTRIES is kept because the original
# Step 3 seed logic and tests reference it).
DOCTOR_ENTRIES: list[tuple[str, str, str, int, list[str], int, str, str, str, float, float]] = DEMO_DOCTORS

# ---------------------------------------------------------------------------
# Demo reviews
# ---------------------------------------------------------------------------
REVIEWER_NAMES = ["Demo User", "Demo Visitor", "Demo Patient", "Demo Guest"]

GENERIC_COMMENTS = [
    "Very helpful and explained everything clearly.",
    "Polite staff and a clean, well-kept clinic.",
    "Short waiting time and a thorough consultation.",
    "Took time to answer all my questions patiently.",
    "Overall a good experience; would visit again.",
]

# Sober comments used for lower-star reviews — no alarming claims.
NEUTRAL_COMMENTS = [
    "Consultation felt a bit rushed, but the advice was reasonable.",
    "Decent experience overall; the waiting time was long.",
]

SPECIALTY_COMMENTS: dict[str, list[str]] = {
    "General Physician": [
        "Listened patiently and explained the next steps clearly.",
        "Simple, practical advice for my fever and weakness.",
        "Follow-up plan was explained well.",
        "Clinic runs on time and the doctor is unhurried.",
    ],
    "Cardiologist": [
        "Explained my reports line by line in simple language.",
        "Calm and reassuring consultation.",
        "Discussed lifestyle changes without scare tactics.",
        "Very systematic examination.",
    ],
    "Dermatologist": [
        "Clear explanation of the skin-care routine to follow.",
        "The prescription was explained, including what to avoid.",
        "Gave realistic expectations instead of big promises.",
        "Answered all my questions about treatment options.",
    ],
    "Dentist": [
        "Gentle cleaning and a clear explanation of the treatment plan.",
        "Explained how to avoid the same issue in future.",
        "Painless experience; the staff was supportive.",
        "Honest advice — no unnecessary procedures suggested.",
    ],
    "Orthopedic": [
        "Explained the X-ray findings patiently.",
        "Focused on exercises and posture first, not surgery.",
        "Clear do's and don'ts for my back problem.",
        "Practical advice for daily movement and rest.",
    ],
    "Gastroenterologist": [
        "Explained the diet changes in simple words.",
        "Very patient while taking my full history.",
        "Follow-up advice was clear and easy to follow.",
        "Did not rush the consultation at all.",
    ],
    "ENT Specialist": [
        "Checked everything carefully and explained the treatment.",
        "Clear guidance for my recurring ear problem.",
        "Simple instructions that were easy to follow.",
        "Explained why the symptom was happening, not just the medicine.",
    ],
    "Pediatrician": [
        "Very gentle with my child and patient with my questions.",
        "Explained the vaccination schedule clearly.",
        "Made my nervous kid comfortable before the check-up.",
        "Practical advice for home care.",
    ],
    "Gynecologist": [
        "Explained the care plan calmly and answered every question.",
        "Made a routine check-up feel comfortable and unhurried.",
    ],
    "Neurologist": [
        "Took a detailed history before suggesting tests.",
        "Explained the possible causes without alarming language.",
        "Structured approach; tests suggested only where needed.",
        "Clear explanation of triggers to watch for.",
    ],
    "Ophthalmologist": [
        "Thorough eye check-up and a clear explanation of the numbers.",
        "Explained the eyewear options without pushing expensive ones.",
        "Careful examination; answered all my questions.",
        "Explained the dry-eye care routine step by step.",
    ],
}

# Integer star plans (2-5 reviews per doctor) so that doctor.rating is the
# exact rounded mean of their seeded reviews — internally consistent data.
STAR_PLANS: dict[int, list[tuple[int, ...]]] = {
    2: [(5, 4), (4, 4), (5, 5), (4, 5)],
    3: [(5, 4, 4), (5, 5, 4), (4, 4, 5), (4, 4, 4), (5, 4, 3)],
    4: [(5, 4, 4, 5), (5, 5, 4, 4), (4, 4, 4, 5), (5, 5, 5, 4), (4, 4, 4, 4)],
    5: [(5, 5, 4, 5, 4), (5, 4, 4, 4, 5), (4, 4, 4, 4, 5), (5, 5, 4, 4, 4), (5, 5, 5, 4, 4)],
}


def _build_doctor(index: int, entry: tuple) -> Doctor:
    (name, specialization, qualification, experience, languages,
     fee, clinic_name, address, city, latitude, longitude) = entry
    bios = BIO_TEMPLATES[specialization]
    n_reviews = 2 + index % 4
    stars = STAR_PLANS[n_reviews][(index + n_reviews) % len(STAR_PLANS[n_reviews])]
    # Round half-up (matching PostgreSQL's ROUND) so the stored rating always
    # equals ROUND(AVG(reviews.rating), 1) in SQL — fully consistent data.
    rating = (Decimal(sum(stars)) / Decimal(len(stars))).quantize(
        Decimal("0.1"), rounding=ROUND_HALF_UP
    )
    return Doctor(
        name=name,
        specialization=specialization,
        qualification=qualification,
        experience_years=experience,
        languages=languages,
        consultation_fee=Decimal(str(fee)),
        clinic_name=clinic_name,
        address=address,
        city=city,
        latitude=latitude,
        longitude=longitude,
        availability=AVAILABILITY_PATTERNS[index % len(AVAILABILITY_PATTERNS)],
        bio=bios[index % len(bios)],
        profile_image=None,  # frontend renders initials avatars for MVP
        rating=rating,
        review_count=len(stars),
        verified=False,
        is_demo=True,
    )


def _build_reviews(doctor_index: int, doctor: Doctor) -> list[Review]:
    stars = STAR_PLANS[2 + doctor_index % 4][
        (doctor_index + 2 + doctor_index % 4) % len(STAR_PLANS[2 + doctor_index % 4])
    ]
    pool = SPECIALTY_COMMENTS.get(doctor.specialization, []) + GENERIC_COMMENTS
    neutral = NEUTRAL_COMMENTS
    now = datetime.now(timezone.utc)
    reviews: list[Review] = []
    for k, star in enumerate(stars):
        comment = (
            neutral[(doctor_index + k) % len(neutral)]
            if star <= 3
            else pool[(doctor_index + k) % len(pool)]
        )
        reviews.append(
            Review(
                doctor=doctor,
                reviewer_name=REVIEWER_NAMES[(doctor_index + k) % len(REVIEWER_NAMES)],
                rating=star,
                comment=comment,
                verified_visit=(k % 2 == 0),
                is_demo=True,
                # Deterministic stagger over the past ~8 months.
                created_at=now - timedelta(days=(doctor_index * 5 + k * 13) % 240 + 3),
            )
        )
    return reviews


def _insert_entries(
    session: Session, indexed_entries: list[tuple[int, tuple]]
) -> dict[str, int]:
    """Insert demo doctors (+ reviews) for the given (dataset index, entry)
    pairs. The dataset index drives the deterministic review/availability
    assignment, so a top-up produces exactly the same rows a fresh seed
    would have produced for those doctors."""
    summary = {"doctors": 0, "reviews": 0}
    for index, entry in indexed_entries:
        doctor = _build_doctor(index, entry)
        reviews = _build_reviews(index, doctor)
        session.add_all([doctor, *reviews])
        summary["doctors"] += 1
        summary["reviews"] += len(reviews)
    return summary


def seed_demo_data(session: Session) -> dict[str, int] | None:
    """First-boot seed: insert the full dataset when the database has NO demo
    doctors at all. Returns counts, or None when demo data already exists
    (in which case nothing is changed)."""
    existing = session.scalar(
        select(func.count()).select_from(Doctor).where(Doctor.is_demo.is_(True))
    )
    if existing:
        return None

    summary = _insert_entries(session, list(enumerate(DOCTOR_ENTRIES)))
    session.commit()
    return summary


def top_up_demo_data(session: Session) -> dict[str, int] | None:
    """Non-destructive dataset upgrade: insert only the demo doctors whose
    (name, city) pair is not yet present in the database.

    A database seeded with an earlier, smaller version of the dataset (e.g.
    the original 44-doctor set on production) gains the new cities and
    specialties while every existing row — demo or not — is left untouched.
    Returns counts, or None when the database already covers the dataset.
    """
    existing_pairs = set(
        session.execute(
            select(Doctor.name, Doctor.city).where(Doctor.is_demo.is_(True))
        ).all()
    )
    missing = [
        (index, entry)
        for index, entry in enumerate(DOCTOR_ENTRIES)
        if (entry[0], entry[8]) not in existing_pairs
    ]
    if not missing:
        return None
    summary = _insert_entries(session, missing)
    session.commit()
    return summary


def main() -> int:
    print("MEDIQO DEMO DATABASE SEED")
    print("=" * 50)
    print("All inserted records are FICTIONAL demo data (is_demo = true).")
    print()

    # Idempotent: only creates missing tables; never alters or drops. Lets
    # the seed run against a fresh/empty database (e.g. Render) as well.
    ensure_schema()

    session = SessionLocal()
    try:
        # Top-up path: adds any dataset doctors missing from this database
        # (fresh database -> inserts everything; older dataset -> gains the
        # new cities/specialties; current dataset -> no-op). Never deletes.
        result = top_up_demo_data(session)
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

    if result is None:
        print("Demo dataset already complete. Nothing to add (no changes made).")
        return 0

    print(f"Doctors inserted: {result['doctors']}")
    print(f"Reviews inserted: {result['reviews']}")
    print()

    spec_counts: dict[str, int] = {}
    city_counts: dict[str, int] = {}
    for entry in DOCTOR_ENTRIES:
        spec_counts[entry[1]] = spec_counts.get(entry[1], 0) + 1
        city_counts[entry[8]] = city_counts.get(entry[8], 0) + 1

    print(f"Dataset now covers {len(DOCTOR_ENTRIES)} demo doctors "
          f"across {len(city_counts)} cities and {len(spec_counts)} specialties.")
    print()
    print("Specializations:")
    for specialization, count in spec_counts.items():
        print(f"  {specialization}: {count}")
    print()
    print("Cities:")
    for city, count in city_counts.items():
        print(f"  {city}: {count}")
    print()
    print("Database seed completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

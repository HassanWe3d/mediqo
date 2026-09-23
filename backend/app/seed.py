"""Mediqo demo seed script (Step 3).

Populates PostgreSQL with a controlled set of FICTIONAL demo doctors and
demo reviews so the matching flow (location + problem -> doctors) can be
demonstrated end to end.

Data policy:
- Every inserted doctor and every inserted review has is_demo=True.
- Reviews are fictional sample content; the frontend must label them as
  demo/sample reviews — never as genuine patient feedback.
- Coordinates are approximate, plausible positions for Lucknow localities
  (and a few nearby cities) so distance calculations are meaningful.
- The script is IDEMPOTENT: if demo doctors already exist it exits without
  changing anything. It never deletes or resets data.

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

from app.database import SessionLocal
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
DOCTOR_ENTRIES: list[tuple[str, str, str, int, list[str], int, str, str, str, float, float]] = [
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

    # --- Nearby cities (4) — for realistic long-distance behaviour later ---
    ("Dr. Anupam Dwivedi", "General Physician", "MBBS", 10, ["Hindi", "English"], 350,
     "Dwivedi Clinic", "Civil Lines", "Kanpur", 26.4520, 80.3310),
    ("Dr. Yash Tyagi", "Orthopedic", "MBBS, MS (Orthopaedics)", 12, ["Hindi", "English"], 700,
     "Tyagi Bone & Joint Clinic", "Mall Road", "Kanpur", 26.4620, 80.3490),
    ("Dr. Sushma Tiwari", "Pediatrician", "MBBS, MD (Paediatrics)", 11, ["Hindi", "English"], 450,
     "Tiwari Child Clinic", "Hospital Road", "Unnao", 26.5480, 80.3650),
    ("Dr. Sachin Dixit", "Ophthalmologist", "MBBS, MS (Ophthalmology)", 14, ["Hindi", "English"], 500,
     "Dixit Eye Hospital", "Station Road", "Sitapur", 27.1750, 80.6820),
]

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


def seed_demo_data(session: Session) -> dict[str, int] | None:
    """Insert the demo dataset. Returns counts, or None if demo data exists."""
    existing = session.scalar(
        select(func.count()).select_from(Doctor).where(Doctor.is_demo.is_(True))
    )
    if existing:
        return None

    summary = {"doctors": 0, "reviews": 0}
    for index, entry in enumerate(DOCTOR_ENTRIES):
        doctor = _build_doctor(index, entry)
        reviews = _build_reviews(index, doctor)
        session.add_all([doctor, *reviews])
        summary["doctors"] += 1
        summary["reviews"] += len(reviews)
    session.commit()
    return summary


def main() -> int:
    print("MEDIQO DEMO DATABASE SEED")
    print("=" * 50)
    print("All inserted records are FICTIONAL demo data (is_demo = true).")
    print()

    session = SessionLocal()
    try:
        result = seed_demo_data(session)
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

    if result is None:
        print("Demo data already exists. Skipping seed (nothing was changed).")
        return 0

    print(f"Doctors inserted: {result['doctors']}")
    print(f"Reviews inserted: {result['reviews']}")
    print()

    spec_counts: dict[str, int] = {}
    city_counts: dict[str, int] = {}
    for entry in DOCTOR_ENTRIES:
        spec_counts[entry[1]] = spec_counts.get(entry[1], 0) + 1
        city_counts[entry[8]] = city_counts.get(entry[8], 0) + 1

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

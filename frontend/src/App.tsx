import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { FlowProvider } from "./state/FlowContext";
import { LandingPage } from "./pages/LandingPage";
import { LocationPage } from "./pages/LocationPage";
import { ProblemPage } from "./pages/ProblemPage";
import { ResultsPage } from "./pages/ResultsPage";
import { DoctorProfilePage } from "./pages/DoctorProfilePage";
import { ManageAppointmentPage } from "./pages/ManageAppointmentPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export default function App() {
  return (
    <FlowProvider>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/location" element={<LocationPage />} />
          <Route path="/problem" element={<ProblemPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/doctor/:id" element={<DoctorProfilePage />} />
          <Route path="/appointments/manage" element={<ManageAppointmentPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </FlowProvider>
  );
}

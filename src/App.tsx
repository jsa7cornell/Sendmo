import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Index from "@/pages/Index";
import RecipientOnboarding from "@/pages/RecipientOnboarding";
import SenderFlow from "@/pages/SenderFlow";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import FAQ from "@/pages/FAQ";
import Admin from "@/pages/Admin";
import LabelTest from "@/pages/LabelTest";
import NotFound from "@/pages/NotFound";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/login" element={<Login />} />
          <Route path="/onboarding" element={<RecipientOnboarding />} />
          <Route path="/s/:shortCode" element={<SenderFlow />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route path="/faq" element={<FAQ />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/label-test" element={<LabelTest />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

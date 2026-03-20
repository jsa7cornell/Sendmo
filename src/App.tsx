import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { RecipientFlowProvider } from "@/contexts/RecipientFlowContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Index from "@/pages/Index";
import RecipientOnboarding from "@/pages/RecipientOnboarding";
import SenderFlow from "@/pages/SenderFlow";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import FAQ from "@/pages/FAQ";
import Admin from "@/pages/Admin";
import LabelTest from "@/pages/LabelTest";
import SenderPreview from "@/pages/SenderPreview";
import TrackingPage from "@/pages/TrackingPage";
import NotFound from "@/pages/NotFound";

// Layout that provides RecipientFlowContext to all onboarding routes
function OnboardingLayout() {
  return (
    <RecipientFlowProvider>
      <Outlet />
    </RecipientFlowProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/login" element={<Login />} />

          {/* Recipient onboarding — URL-based step routing */}
          <Route path="/onboarding" element={<OnboardingLayout />}>
            <Route index element={<RecipientOnboarding />} />
            <Route path=":step" element={<RecipientOnboarding />} />
          </Route>

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
          <Route path="/track/:trackingNumber" element={<TrackingPage />} />
          <Route path="/label-test" element={<LabelTest />} />
          <Route path="/sender-preview" element={<SenderPreview />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

import { BrowserRouter, Routes, Route, Outlet, Navigate, useSearchParams } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
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
import HeaderPreview from "@/pages/HeaderPreview";
import TrackingPage from "@/pages/TrackingPage";
import LinksNew from "@/pages/LinksNew";
import LinksEdit from "@/pages/LinksEdit";
import NotFound from "@/pages/NotFound";

// Auth'd users land on /links/new instead of the wizard. Anon users get the wizard
// wrapped in RecipientFlowProvider. Provider only mounts on the anon branch.
function OnboardingLayout() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  if (loading) return null;
  if (user) {
    const path = searchParams.get("path");
    const target = path === "full_label" ? "/links/new?path=full_label" : "/links/new";
    return <Navigate to={target} replace />;
  }
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
          <Route
            path="/links/new"
            element={
              <ProtectedRoute>
                <LinksNew />
              </ProtectedRoute>
            }
          />
          <Route
            path="/links/:id/edit"
            element={
              <ProtectedRoute>
                <LinksEdit />
              </ProtectedRoute>
            }
          />
          <Route path="/faq" element={<FAQ />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/track/:trackingNumber" element={<TrackingPage />} />
          <Route path="/label-test" element={<LabelTest />} />
          <Route path="/sender-preview" element={<SenderPreview />} />
          <Route path="/header-preview" element={<HeaderPreview />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

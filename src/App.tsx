import { BrowserRouter, Routes, Route, Outlet, Navigate, useSearchParams, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { RecipientFlowProvider } from "@/contexts/RecipientFlowContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Index from "@/pages/Index";
import RecipientOnboarding from "@/pages/RecipientOnboarding";
import SenderFlow from "@/pages/SenderFlow";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";
import FAQ from "@/pages/FAQ";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import Admin from "@/pages/Admin";
import LabelTest from "@/pages/LabelTest";
import SenderPreview from "@/pages/SenderPreview";
import HeaderPreview from "@/pages/HeaderPreview";
import TrackingPage from "@/pages/TrackingPage";
import LinksNew from "@/pages/LinksNew";
import LinksEdit from "@/pages/LinksEdit";
import NotFound from "@/pages/NotFound";
import AppHeader from "@/components/AppHeader";
import RecipientStepPathChoice from "@/components/recipient/RecipientStepPathChoice";

// Auth'd user landed on /onboarding without choosing a path → show the
// chooser instead of jumping straight into the flexible-link editor. With
// a deep-link (?path=flexible|full_label) they go directly to the right
// destination. Anon users get the full wizard wrapped in RecipientFlowProvider.
function OnboardingLayout() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  if (loading) return null;
  if (user) {
    const path = searchParams.get("path");
    if (path === "flexible") return <Navigate to="/links/new" replace />;
    if (path === "full_label") return <Navigate to="/links/new?path=full_label" replace />;
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
        <AppHeader />
        <div className="max-w-3xl mx-auto px-4 py-8">
          <RecipientStepPathChoice
            onSelect={(p) =>
              navigate(p === "full_label" ? "/links/new?path=full_label" : "/links/new")
            }
          />
        </div>
      </div>
    );
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
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
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

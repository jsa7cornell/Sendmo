import { BrowserRouter, Routes, Route, Outlet, Navigate, useNavigate } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { AuthProvider } from "@/contexts/AuthContext";
import { RecipientFlowProvider } from "@/contexts/RecipientFlowContext";
import { startFlowAs } from "@/lib/recipientFlowStorage";
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
import AdminShipmentDetail from "@/pages/AdminShipmentDetail";
import AdminUserDetail from "@/pages/AdminUserDetail";
import LabelTest from "@/pages/LabelTest";
import SenderPreview from "@/pages/SenderPreview";
import HeaderPreview from "@/pages/HeaderPreview";
import LinkSharePreview from "@/pages/LinkSharePreview";
import TrackingPage from "@/pages/TrackingPage";
import LabelPrintPage from "@/pages/LabelPrintPage";
import LegacyTrackingRedirect from "@/pages/LegacyTrackingRedirect";
import LinksNew from "@/pages/LinksNew";
import LinksEdit from "@/pages/LinksEdit";
import SellerBuilder from "@/pages/SellerBuilder";
import NotFound from "@/pages/NotFound";
import AppHeader from "@/components/AppHeader";
import RecipientStepWhoSending from "@/components/recipient/RecipientStepWhoSending";

// T1-3 monitoring (proposal review B1): gives Sentry events parameterized
// route names (/onboarding/:pathSlug/:stepSlug, not raw URLs). Pass-through
// when Sentry.init was never called — route definitions are unchanged.
const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

// Step 0 — "Who's sending the package?", shown at /onboarding.
//
// Renders outside RecipientFlowProvider (the provider lives at
// /onboarding/:pathSlug so its useParams can read the slugs), so the answer is
// handed over through the flow's own sessionStorage seam via startFlowAs.
//
// BOTH answers enter the full-label path. "Someone else" defaults there
// optimistically — it is the common case, and the only thing that moves a flow
// to the shipping-link path is the "I don't have their address" escape at the
// origin step. That keeps both URL slugs meaningful, leaves Sentry's
// parameterized route names intact, and keeps every existing deep link valid.
function OnboardingWhoSending() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />
      <div className="max-w-3xl mx-auto px-4 py-8">
        <RecipientStepWhoSending
          onSelect={(sender) => {
            startFlowAs(sender);
            // Also carried in router state: `startFlowAs` writes sessionStorage,
            // which is best-effort and silently no-ops when storage is
            // unavailable. The provider seeds from whichever arrives.
            navigate("/onboarding/full-label/destination", { state: { sender } });
          }}
          onSellInstead={() => navigate("/sell")}
        />
      </div>
    </div>
  );
}

// Wraps the multi-step flow in its provider. Auth-aware prefill happens
// inside the provider itself; both anon and authed users mount here.
function OnboardingFlowLayout() {
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
        <SentryRoutes>
          <Route path="/" element={<Index />} />
          <Route path="/login" element={<Login />} />

          {/* Recipient onboarding — path-scoped URL routing */}
          <Route path="/onboarding" element={<OnboardingWhoSending />} />
          <Route path="/onboarding/:pathSlug" element={<OnboardingFlowLayout />}>
            {/* Bare /onboarding/{path} → redirect to first step */}
            <Route index element={<Navigate to="destination" replace />} />
            <Route path=":stepSlug" element={<RecipientOnboarding />} />
          </Route>

          {/* Seller-builder — buyer-pays "Sell & Ship" link (separate from the recipient flow) */}
          <Route path="/sell" element={<SellerBuilder />} />

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
          <Route path="/admin/shipments/:public_code" element={<AdminShipmentDetail />} />
          <Route path="/admin/users/:userId" element={<AdminUserDetail />} />
          <Route path="/t/:code" element={<TrackingPage />} />
          <Route path="/t/:code/print" element={<LabelPrintPage />} />
          <Route path="/track/:trackingNumber" element={<LegacyTrackingRedirect />} />
          <Route path="/label-test" element={<LabelTest />} />
          <Route path="/sender-preview" element={<SenderPreview />} />
          <Route path="/header-preview" element={<HeaderPreview />} />
          <Route path="/link-share-preview" element={<LinkSharePreview />} />
          <Route path="*" element={<NotFound />} />
        </SentryRoutes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

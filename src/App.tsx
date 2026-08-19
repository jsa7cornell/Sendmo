import { BrowserRouter, Routes, Route, Outlet, Navigate, useNavigate } from "react-router-dom";
import * as Sentry from "@sentry/react";
import { AuthProvider } from "@/contexts/AuthContext";
import { RecipientFlowProvider } from "@/contexts/RecipientFlowContext";
import { startFreshFlow, loadResumable, clearFlow } from "@/lib/recipientFlowStorage";
import { firstIncompleteUrl } from "@/lib/stepRouting";
import { useState } from "react";
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

// T1-3 monitoring (proposal review B1): gives Sentry events parameterized
// route names (/onboarding/:pathSlug/:stepSlug, not raw URLs). Pass-through
// when Sentry.init was never called — route definitions are unchanged.
const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

// Entry to /onboarding (2026-08-18: the who's-sending picker is gone — the
// flow itself resolves who's sending, via the "use my address" chips and the
// defer answers). Two jobs remain:
//   1. Offer — never auto-apply — an unfinished draft. Landing on the
//      destination step directly would let the provider silently rehydrate an
//      old draft's fields, so when a resumable draft exists this screen makes
//      the user choose first (Continue / Start fresh).
//   2. Otherwise, resolve straight to the destination step. Both former doors
//      enter the same URL, so every existing deep link stays valid.
function OnboardingEntry() {
  const navigate = useNavigate();
  const [draft] = useState(() => loadResumable());
  if (!draft) {
    // A draft can exist and NOT be offerable — finished (labelResult /
    // short_code set) or past the 7-day TTL. The provider hydrates whatever
    // loadPersisted returns, so redirecting with it still in storage silently
    // rehydrates last shipment's addresses and resolved sender into a "new"
    // flow (review finding 1, 2026-08-18). The mandatory step-0 door used to
    // reset storage on every entry; this clear is that reset's replacement.
    clearFlow();
    return <Navigate to="/onboarding/full-label/destination" replace />;
  }
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
          <p className="text-sm text-foreground">
            <span className="font-medium">You have a shipment in progress.</span>{" "}
            <span className="text-muted-foreground">
              Pick up where you left off, or start a new one.
            </span>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                startFreshFlow();
                navigate("/onboarding/full-label/destination", { replace: true });
              }}
              className="text-sm text-muted-foreground rounded-xl px-3 py-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Start fresh
            </button>
            <button
              type="button"
              onClick={() => navigate(firstIncompleteUrl(draft.completedSteps, draft.path ?? "full_label"), { replace: true })}
              className="text-sm font-medium text-primary-foreground bg-primary rounded-xl px-4 py-2 shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Continue
            </button>
          </div>
        </div>
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
          <Route path="/onboarding" element={<OnboardingEntry />} />
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

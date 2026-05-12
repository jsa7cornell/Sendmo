import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Loader2 } from "lucide-react";
import AddressForm from "@/components/forms/AddressForm";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import type { AddressInput, RecipientPath } from "@/lib/types";

interface Props {
  address: AddressInput;
  email: string;
  path: RecipientPath | null;
  errors: string[];
  tried: boolean;
  onAddressChange: (addr: AddressInput) => void;
  onEmailChange: (email: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepAddress({
  address, email, path, errors, tried,
  onAddressChange, onEmailChange, onContinue, onBack,
}: Props) {
  const showErrors = tried && errors.length > 0;
  const { user } = useAuth();
  const prefillAttempted = useRef(false);
  // Track the last email we primed an OTP for, so on-blur is idempotent and
  // we don't burn through Supabase's 60s OTP rate limit. Only fires for the
  // full-label flow (proposal 2026-05-11_account-creation-timing T2 — code
  // is in the inbox by the time the user reaches the verify step).
  const lastPrimedEmail = useRef<string | null>(null);
  const lastPrimedAt = useRef<number>(0);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const maybePrimeOtp = useCallback((candidate: string) => {
    if (path !== "full_label") return;
    const cleaned = candidate.trim().toLowerCase();
    if (!cleaned || !/^.+@.+\..+$/.test(cleaned)) return;
    if (user?.email && user.email.toLowerCase() === cleaned) return;
    if (lastPrimedEmail.current === cleaned && Date.now() - lastPrimedAt.current < 60_000) return;
    lastPrimedEmail.current = cleaned;
    lastPrimedAt.current = Date.now();
    // Send both a 6-digit code (Token) and a confirmation link
    // (ConfirmationURL) — the Supabase email template emits both so the user
    // picks whichever is faster. The link redirects back to the verify step
    // with ?confirmed=1 so the same-device click path stays in this funnel.
    const redirectTo = `${window.location.origin}/onboarding/full-label/verify?confirmed=1`;
    supabase.auth
      .signInWithOtp({ email: cleaned, options: { emailRedirectTo: redirectTo } })
      .catch(() => {});
  }, [path, user?.email]);

  async function handleGoogle() {
    setAuthError(null);
    setGoogleLoading(true);
    // After OAuth, land back on step 1 so the rest of the flow proceeds with
    // a session in scope. The sessionStorage-backed flow data preserves the
    // user's typed destination / picked rates across the redirect.
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (oauthErr) {
      setGoogleLoading(false);
      setAuthError(oauthErr.message || "Google sign-in failed");
    }
  }

  // When OAuth returns, lock the email field to the Google identity. The
  // verify step is skipped because the session itself is the verification.
  useEffect(() => {
    if (!user?.email) return;
    if (email && email.toLowerCase() === user.email.toLowerCase()) return;
    onEmailChange(user.email);
  }, [user?.email, email, onEmailChange]);

  // Silent prefill: when signed-in user lands here with empty fields, populate
  // from their most recent address + profile email. User can edit freely.
  useEffect(() => {
    if (!user || prefillAttempted.current) return;
    if (address.verified || address.street || email) return;
    prefillAttempted.current = true;

    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, is_verified")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (recentAddr) {
        onAddressChange({
          name: recentAddr.name || profile?.full_name || "",
          street: recentAddr.street1 || "",
          city: recentAddr.city,
          state: recentAddr.state,
          zip: recentAddr.zip,
          verified: !!recentAddr.is_verified,
        });
      }

      const fillEmail = profile?.email ?? user.email ?? "";
      if (fillEmail) onEmailChange(fillEmail);
    })();
  }, [user, address.verified, address.street, email, onAddressChange, onEmailChange]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Where should the package be delivered?</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Enter the destination address and your email
        </p>
      </div>

      {/* Destination address */}
      <AddressForm value={address} tried={tried} onChange={onAddressChange} />

      {/* Email + identity card. Google CTA is on top so the user notices the
          shortcut before they reach for the keyboard. If they pick Google,
          email auto-fills from the OAuth identity and the confirm-your-email
          step is skipped entirely (session is the verification). */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <div>
          <label htmlFor="recipient-email" className="text-sm font-medium text-foreground">
            Your email
          </label>
          <p className="text-xs text-muted-foreground mt-1">
            We use this to send your label and shipping updates. Pick the
            fastest way to confirm it's yours.
          </p>
        </div>

        {path === "full_label" && !user && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleGoogle}
              disabled={googleLoading}
              className="w-full rounded-xl shadow-sm gap-2"
            >
              {googleLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                  <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
                </svg>
              )}
              {googleLoading ? "Redirecting…" : "Continue with Google"}
            </Button>
            <p className="text-[11px] text-muted-foreground text-center -mt-2">
              We'll use the email on your Google account. No confirmation needed.
            </p>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-card px-2 text-xs text-muted-foreground">or type your email</span>
              </div>
            </div>
          </>
        )}

        <div>
          <Input
            id="recipient-email"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            onBlur={() => maybePrimeOtp(email)}
            placeholder="you@example.com"
            disabled={!!user}
            className={`rounded-xl ${
              tried && (!email.trim() || !/^.+@.+\..+$/.test(email.trim()))
                ? "border-destructive"
                : ""
            }`}
          />
          {user ? (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Signed in as {user.email}. We'll use this email for the shipment.
            </p>
          ) : path === "full_label" ? (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              We'll send a confirmation link and a 6-digit code. Use either one.
            </p>
          ) : null}
        </div>

        {authError && (
          <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {authError}
          </div>
        )}
      </div>

      {/* Validation summary */}
      <AnimatePresence>
        {showErrors && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Please fix the following:</span>
            </div>
            <ul className="text-sm text-destructive space-y-0.5 ml-6">
              {errors.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          {path === "full_label" ? "Continue to shipment details" : "Continue to shipping preferences"}
        </Button>
      </div>
    </div>
  );
}

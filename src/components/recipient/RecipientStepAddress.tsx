import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
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
  // Track the last email we primed an OTP for — keeps on-blur idempotent and
  // avoids burning through Supabase's 60s OTP rate limit.
  const lastPrimedEmail = useRef<string | null>(null);
  const lastPrimedAt = useRef<number>(0);
  // Detect the null→non-null user transition so we only auto-advance for a
  // fresh OAuth return, not for users who were already signed in on mount.
  const wasNullOnMount = useRef(!user);
  const autoAdvanceFiredRef = useRef(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [autoAdvancing, setAutoAdvancing] = useState(false);

  const maybePrimeOtp = useCallback((candidate: string) => {
    const cleaned = candidate.trim().toLowerCase();
    if (!cleaned || !/^.+@.+\..+$/.test(cleaned)) return;
    if (user?.email && user.email.toLowerCase() === cleaned) return;
    if (lastPrimedEmail.current === cleaned && Date.now() - lastPrimedAt.current < 60_000) return;
    lastPrimedEmail.current = cleaned;
    lastPrimedAt.current = Date.now();
    // Flex uses its own verify URL so the email link lands on the right step.
    const redirectTo = path === "flexible"
      ? `${window.location.origin}/onboarding/flexible/verify?confirmed=1`
      : `${window.location.origin}/onboarding/full-label/verify?confirmed=1`;
    supabase.auth
      .signInWithOtp({ email: cleaned, options: { emailRedirectTo: redirectTo } })
      .catch(() => {});
  }, [path, user?.email]);

  async function handleGoogle() {
    setAuthError(null);
    setGoogleLoading(true);
    // Redirect back to this exact step so flow state (stored in sessionStorage)
    // is restored automatically and the rest of the flow proceeds with a session.
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (oauthErr) {
      setGoogleLoading(false);
      setAuthError(oauthErr.message || "Google sign-in failed");
    }
  }

  // Lock email to the Google identity when OAuth returns. The verify step is
  // skipped for Google users because the session itself is the verification.
  useEffect(() => {
    if (!user?.email) return;
    if (email && email.toLowerCase() === user.email.toLowerCase()) return;
    onEmailChange(user.email);
  }, [user?.email, email, onEmailChange]);

  // Silent prefill: returning signed-in user with empty fields gets their most
  // recent address and profile email pre-populated. User can still edit freely.
  useEffect(() => {
    if (!user || prefillAttempted.current) return;
    if (address.verified || address.street || email) return;
    prefillAttempted.current = true;

    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name, phone").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, phone, is_verified")
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
          phone: recentAddr.phone || profile?.phone || "",
          verified: !!recentAddr.is_verified,
        });
      }

      const fillEmail = profile?.email ?? user.email ?? "";
      if (fillEmail) onEmailChange(fillEmail);
    })();
  }, [user, address.verified, address.street, email, onAddressChange, onEmailChange]);

  // Auto-advance after OAuth return when the address is already filled.
  // Fires only for fresh OAuth returns (wasNullOnMount=true), not for users
  // who were already signed in when this step mounted.
  useEffect(() => {
    if (!user || !wasNullOnMount.current || autoAdvanceFiredRef.current) return;
    const { street, city, state, zip } = address;
    if (!street || !city || !state || !zip) return;
    autoAdvanceFiredRef.current = true;
    setAutoAdvancing(true);
    const timer = setTimeout(onContinue, 2000);
    return () => clearTimeout(timer);
  }, [user, address, onContinue]);

  const displayName = user?.user_metadata?.full_name as string | undefined;
  const avatarInitial = (displayName || user?.email || "?")[0].toUpperCase();

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

      {/* Identity / auth card. Google leads — if the user picks it, email
          auto-fills from OAuth and the verify step is skipped entirely. */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        {user ? (
          /* ── Signed-in identity pill ── */
          <div className="flex items-start gap-3">
            <div
              className="w-9 h-9 rounded-full bg-primary/10 text-primary font-semibold text-sm flex items-center justify-center shrink-0"
              aria-hidden="true"
            >
              {avatarInitial}
            </div>
            <div className="flex-1 min-w-0">
              {displayName && (
                <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
              )}
              <p className={`text-sm truncate ${displayName ? "text-muted-foreground" : "font-medium text-foreground"}`}>
                {user.email}
              </p>
              {autoAdvancing ? (
                <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  Continuing…
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  We'll send shipping updates to this address.
                </p>
              )}
            </div>
            <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" aria-label="Verified" />
          </div>
        ) : (
          /* ── Auth options: Google-first, email secondary ── */
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleGoogle}
              disabled={googleLoading}
              className="w-full rounded-xl shadow-sm gap-2"
            >
              {googleLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
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
                <span className="bg-card px-2 text-xs text-muted-foreground">or use your email</span>
              </div>
            </div>

            <div>
              <Input
                id="recipient-email"
                type="email"
                value={email}
                onChange={(e) => onEmailChange(e.target.value)}
                onBlur={() => maybePrimeOtp(email)}
                placeholder="Email address"
                aria-label="Email address"
                className={`rounded-xl ${
                  tried && (!email.trim() || !/^.+@.+\..+$/.test(email.trim()))
                    ? "border-destructive"
                    : ""
                }`}
              />
              {path === "full_label" ? (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  We'll send a confirmation link and a 6-digit code. Use either one.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  We'll send shipping updates and a confirmation code to this address.
                </p>
              )}
            </div>

            {authError && (
              <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {authError}
              </div>
            )}
          </>
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
        <Button onClick={onContinue} disabled={autoAdvancing} className="flex-1 rounded-xl shadow-sm">
          {path === "full_label" ? "Continue to shipment details" : "Continue to shipping preferences"}
        </Button>
      </div>
    </div>
  );
}

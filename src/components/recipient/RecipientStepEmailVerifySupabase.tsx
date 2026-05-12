import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, Info, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// "Confirm your email" step for the Full Prepaid Label flow.
//
// Framing: this is email **verification** (the address is real and the user
// owns it), not account creation. Supabase Auth does create an auth.users
// row as a side effect — that's how shipments.user_id gets stamped — but the
// user-facing message stays focused on "is this email yours."
//
// Two paths share this screen:
//   1. Tap the link in the email → Supabase verifies + redirects back here
//      with ?confirmed=1 → the OAuth-return useEffect notices the session
//      and auto-advances.
//   2. Type the 6-digit code from the email → verifyOtp({type:"email"}) →
//      same auto-advance path.
//
// The Google CTA lives at step 1 (destination), NOT here — if the user
// picked Google there, they never reach this screen because step-11's
// validation passes via the auto-skip in RecipientFlowContext.
//
// Companion to the bespoke `email_verifications`-table flow used by the
// flex path at step 21 (intentionally NOT touched per proposal
// 2026-05-11_account-creation-timing B1).

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepEmailVerifySupabase({
  state,
  onUpdate,
  onContinue,
  onBack,
}: Props) {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const arrivedViaLink = searchParams.get("confirmed") === "1";
  const [resending, setResending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const oauthLockApplied = useRef(false);

  const email = state.verification_email || state.email;

  // Strip ?confirmed=1 from the URL on first paint — same one-shot pattern
  // as TrackingPage's ?fresh=1 handling. Keeps the URL clean if the user
  // navigates back.
  useEffect(() => {
    if (arrivedViaLink) {
      const next = new URLSearchParams(searchParams);
      next.delete("confirmed");
      setSearchParams(next, { replace: true });
    }
  }, [arrivedViaLink, searchParams, setSearchParams]);

  // ── Authenticated-session detection ─────────────────────────
  // Two ways the user reaches this screen with a live session:
  //   1. They tapped the confirmation link in the email — Supabase set the
  //      session and redirected back with ?confirmed=1.
  //   2. They picked "Continue with Google" at step 1 — they shouldn't
  //      reach this screen at all (RecipientFlowContext auto-skips it),
  //      but if they do, the session is still proof of verification.
  // In either case: mark email_verified=true and auto-advance. If the
  // session email differs from the typed one (Google with a different
  // email), lock to the session email and surface a disclosure (B2).
  useEffect(() => {
    if (!user?.email || oauthLockApplied.current) return;
    if (state.email_verified) return;
    oauthLockApplied.current = true;
    const authEmail = user.email;
    if (authEmail.toLowerCase() !== (email || "").toLowerCase()) {
      onUpdate({
        email: authEmail,
        verification_email: authEmail,
        email_verified: true,
      });
      setInfo(`Signed in as ${authEmail}. Shipment notifications will go to that address.`);
    } else {
      onUpdate({ email_verified: true });
      if (arrivedViaLink) setInfo("Email confirmed — taking you to payment…");
    }
  }, [user, email, state.email_verified, onUpdate, arrivedViaLink]);

  // Auto-advance after verification
  useEffect(() => {
    if (state.email_verified) {
      const timer = setTimeout(onContinue, 1000);
      return () => clearTimeout(timer);
    }
  }, [state.email_verified, onContinue]);

  // Focus the first digit input on mount
  useEffect(() => {
    if (state.email_verified) return;
    setTimeout(() => inputRefs.current[0]?.focus(), 100);
  }, [state.email_verified]);

  const handleDigitChange = useCallback((index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const char = value.slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = char;
      return next;
    });
    if (char && index < 5) inputRefs.current[index + 1]?.focus();
  }, []);

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 0) return;
    e.preventDefault();
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    inputRefs.current[Math.min(pasted.length, 5)]?.focus();
  }

  async function handleVerify() {
    const code = digits.join("");
    if (code.length < 6) {
      setError("Enter the full 6-digit code");
      return;
    }
    if (!email) {
      setError("Missing email — go back and re-enter it");
      return;
    }
    setError(null);
    setVerifying(true);
    const { error: verifyErr } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    setVerifying(false);
    if (verifyErr) {
      setError(verifyErr.message || "Verification failed");
      return;
    }
    onUpdate({ verification_email: email, email_verified: true });
  }

  async function handleResend() {
    if (!email) {
      setError("Missing email — go back and re-enter it");
      return;
    }
    setError(null);
    setInfo(null);
    setResending(true);
    const redirectTo = `${window.location.origin}/onboarding/full-label/verify?confirmed=1`;
    const { error: sendErr } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    setResending(false);
    if (sendErr) {
      setError(sendErr.message || "Could not send a new email");
      return;
    }
    setInfo(`We re-sent the link + code to ${email}`);
  }

  function handleEditEmail() {
    onBack();
  }

  if (state.email_verified) {
    return (
      <div className="space-y-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-success/10 border border-success/30 rounded-2xl p-6 text-center"
        >
          <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-2" />
          <h2 className="text-xl font-bold text-foreground">Email verified</h2>
          <p className="text-sm text-muted-foreground mt-1">{email}</p>
        </motion.div>
        {info && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground flex gap-2">
            <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <span>{info}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Mail className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Confirm your email</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Just making sure <span className="font-medium text-foreground">{email}</span> is
          yours. Tap the link in the email — or paste the 6-digit code below.
        </p>
      </div>

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label className="text-sm font-medium text-foreground block mb-3 text-center">
          Paste or type the 6-digit code
        </label>
        <div className="flex justify-center gap-2 mb-4">
          {digits.map((d, i) => (
            <Input
              key={i}
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={d}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={i === 0 ? handlePaste : undefined}
              aria-label={`Digit ${i + 1}`}
              className="w-11 h-13 text-center text-xl font-semibold rounded-xl"
            />
          ))}
        </div>

        <Button
          onClick={handleVerify}
          disabled={verifying || digits.join("").length < 6}
          className="w-full rounded-xl shadow-sm"
        >
          {verifying ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Verifying…
            </>
          ) : (
            "Verify and continue"
          )}
        </Button>

        <div className="text-center mt-3 text-xs">
          <button
            type="button"
            onClick={handleResend}
            disabled={resending}
            className="text-primary hover:underline mr-3"
          >
            {resending ? "Sending…" : "Resend code"}
          </button>
          <button
            type="button"
            onClick={handleEditEmail}
            className="text-muted-foreground hover:underline"
          >
            Use a different email
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground text-center">
        Tapping the link in your email also works — it sends you right back here.
      </p>

      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {info && !error && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground flex gap-2">
          <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <span>{info}</span>
        </div>
      )}

      <Button variant="ghost" onClick={onBack} className="rounded-xl">
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back
      </Button>
    </div>
  );
}

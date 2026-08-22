import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, Info, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// The Contact step — where the creator's identity is collected AND confirmed.
//
// Both halves live here as of 2026-08-22. The email input and Google CTA used
// to sit on the destination step, which put an account question on a screen
// that asks where a package goes; this screen already existed to confirm the
// address, so it now owns getting it too.
//
// Three ways through:
//   1. Google → the session IS the verification; the code half never renders.
//   2. Email → magic link in the mail → Supabase redirects back with
//      ?confirmed=1 → session detected → auto-advance.
//   3. Email → type the 6-digit code → verifyOtp → auto-advance.
//
// One component for both paths; only the redirect target differs, so the
// email link lands on the right step's URL.

// Set immediately before redirecting to Google; its presence on return is what
// distinguishes a fresh OAuth return from an ordinary visit.
const OAUTH_PENDING_KEY = "sendmo:oauth_pending";

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepContact({ state, onUpdate, onContinue, onBack }: Props) {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const arrivedViaLink = searchParams.get("confirmed") === "1";
  const [emailDraft, setEmailDraft] = useState(state.email);
  const [sending, setSending] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const oauthLockApplied = useRef(false);

  const email = state.verification_email || state.email;
  // A code has been sent iff verification_email is set — which is exactly what
  // that field means, so the phase survives back-navigation for free.
  const awaitingCode = !!state.verification_email;

  const redirectTo = state.path === "flexible"
    ? `${window.location.origin}/onboarding/flexible/verify?confirmed=1`
    : `${window.location.origin}/onboarding/full-label/verify?confirmed=1`;

  // Strip ?confirmed=1 from the URL on first paint — keeps the URL clean if
  // the user navigates back.
  useEffect(() => {
    if (arrivedViaLink) {
      const next = new URLSearchParams(searchParams);
      next.delete("confirmed");
      setSearchParams(next, { replace: true });
    }
  }, [arrivedViaLink, searchParams, setSearchParams]);

  // A live session is proof of verification however it was obtained — the
  // magic link, the code, or Google. If the session email differs from the
  // typed one, lock to the session's and say so.
  useEffect(() => {
    if (!user?.email || oauthLockApplied.current) return;
    if (state.email_verified) return;
    oauthLockApplied.current = true;
    try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* noop */ }
    const authEmail = user.email;
    if (authEmail.toLowerCase() !== (email || "").toLowerCase()) {
      onUpdate({ email: authEmail, verification_email: authEmail, email_verified: true });
      setInfo(`Signed in as ${authEmail}. Shipment notifications will go to that address.`);
    } else {
      onUpdate({ email_verified: true });
      if (arrivedViaLink) setInfo("Email confirmed — taking you to payment…");
    }
  }, [user, email, state.email_verified, onUpdate, arrivedViaLink]);

  // Auto-advance after verification. onContinue is read through a ref so the
  // timer arms exactly once when email_verified flips — the parent recreates
  // onContinue every render, and depending on it directly made each re-render
  // (auth events, ?confirmed=1 strip, info toast) clear and restart the 1s
  // timer, delaying the advance indefinitely under load.
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;
  useEffect(() => {
    if (state.email_verified) {
      const timer = setTimeout(() => onContinueRef.current(), 1000);
      return () => clearTimeout(timer);
    }
  }, [state.email_verified]);

  useEffect(() => {
    if (state.email_verified || !awaitingCode) return;
    setTimeout(() => inputRefs.current[0]?.focus(), 100);
  }, [state.email_verified, awaitingCode]);

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

  async function handleGoogle() {
    setError(null);
    setGoogleLoading(true);
    try {
      sessionStorage.setItem(OAUTH_PENDING_KEY, "1");
    } catch { /* best-effort */ }
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (oauthErr) {
      try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* noop */ }
      setGoogleLoading(false);
      setError(oauthErr.message || "Google sign-in failed");
    }
  }

  async function handleSendCode() {
    const cleaned = emailDraft.trim().toLowerCase();
    if (!/^.+@.+\..+$/.test(cleaned)) {
      setError("Enter a valid email address");
      return;
    }
    setError(null);
    setInfo(null);
    setSending(true);
    const { error: sendErr } = await supabase.auth.signInWithOtp({
      email: cleaned,
      options: { emailRedirectTo: redirectTo },
    });
    setSending(false);
    if (sendErr) {
      setError(sendErr.message || "Could not send the email");
      return;
    }
    onUpdate({ email: cleaned, verification_email: cleaned });
  }

  async function handleVerify() {
    const code = digits.join("");
    if (code.length < 6) {
      setError("Enter the full 6-digit code");
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
    setError(null);
    setInfo(null);
    setSending(true);
    const { error: sendErr } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    setSending(false);
    if (sendErr) {
      setError(sendErr.message || "Could not send a new email");
      return;
    }
    setInfo(`We re-sent the link + code to ${email}`);
  }

  // Back to the email field. Clearing verification_email is what returns the
  // step to its collect phase.
  function handleUseDifferentEmail() {
    setDigits(["", "", "", "", "", ""]);
    setError(null);
    setInfo(null);
    setEmailDraft(email);
    onUpdate({ verification_email: "" });
  }

  const messages = (
    <>
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
    </>
  );

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

  if (!awaitingCode) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Mail className="w-5 h-5 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">How do we reach you?</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            We'll send shipping updates here — and confirm the address is yours.
          </p>
        </div>

        <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
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

          <Input
            id="contact-email"
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSendCode(); }}
            placeholder="Email address"
            aria-label="Email address"
            className="rounded-xl"
          />
          <Button
            onClick={handleSendCode}
            disabled={sending || !emailDraft.trim()}
            className="w-full rounded-xl shadow-sm"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending…
              </>
            ) : (
              "Send me a code"
            )}
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            We'll send a confirmation link and a 6-digit code. Use either one.
          </p>
        </div>

        {messages}

        <Button variant="ghost" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
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
            disabled={sending}
            className="text-primary hover:underline mr-3"
          >
            {sending ? "Sending…" : "Resend code"}
          </button>
          <button
            type="button"
            onClick={handleUseDifferentEmail}
            className="text-muted-foreground hover:underline"
          >
            Use a different email
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground text-center">
        Tapping the link in your email also works — it sends you right back here.
      </p>

      {messages}

      <Button variant="ghost" onClick={onBack} className="rounded-xl">
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back
      </Button>
    </div>
  );
}

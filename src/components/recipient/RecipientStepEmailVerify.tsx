import { useState, useRef, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { Mail, CheckCircle2, ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import { sendOTP, confirmOTP } from "@/lib/api";

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepEmailVerify({ state, onUpdate, onContinue, onBack }: Props) {
  const [sending, setSending] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const email = state.verification_email || state.email;

  // Auto-advance after verification
  useEffect(() => {
    if (state.email_verified) {
      const timer = setTimeout(onContinue, 1000);
      return () => clearTimeout(timer);
    }
  }, [state.email_verified, onContinue]);

  async function handleSendCode() {
    if (!email || !/^.+@.+\..+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    setError(null);
    setSending(true);

    try {
      await sendOTP(email);
      setSending(false);
      setCodeSent(true);
      onUpdate({ verification_email: email });
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch (err) {
      setSending(false);
      setError(err instanceof Error ? err.message : "Failed to send code");
    }
  }

  const handleDigitChange = useCallback(
    (index: number, value: string) => {
      if (!/^\d*$/.test(value)) return;
      const char = value.slice(-1);
      setDigits((prev) => {
        const next = [...prev];
        next[index] = char;
        return next;
      });
      // Auto-advance to next input
      if (char && index < 5) {
        inputRefs.current[index + 1]?.focus();
      }
    },
    [],
  );

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  async function handleVerify() {
    const code = digits.join("");
    if (code.length < 6) {
      setError("Enter the full 6-digit code");
      return;
    }
    setError(null);
    setVerifying(true);

    try {
      await confirmOTP(email, code);
      setVerifying(false);
      onUpdate({ email_verified: true });
    } catch (err) {
      setVerifying(false);
      setError(err instanceof Error ? err.message : "Verification failed");
    }
  }

  // Already verified — show success
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
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Mail className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Verify your email</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          We'll send notifications about your shipping link to this address.
        </p>
      </div>

      {/* Email input */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label className="text-sm font-medium text-foreground">Email address</label>
        <Input
          type="email"
          value={email}
          onChange={(e) => onUpdate({ verification_email: e.target.value })}
          placeholder="you@example.com"
          disabled={codeSent}
          className="mt-2 rounded-xl"
        />

        {!codeSent ? (
          <Button
            onClick={handleSendCode}
            disabled={sending}
            className="w-full mt-4 rounded-xl shadow-sm"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending…
              </>
            ) : (
              "Send verification code"
            )}
          </Button>
        ) : (
          <div className="mt-3 text-xs text-muted-foreground text-center">
            Code sent to <span className="font-medium text-foreground">{email}</span>
            <button
              type="button"
              onClick={() => {
                setCodeSent(false);
                setDigits(["", "", "", "", "", ""]);
              }}
              className="ml-2 text-primary hover:underline"
            >
              Use different email
            </button>
          </div>
        )}
      </div>

      {/* OTP input */}
      {codeSent && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-card rounded-2xl border border-border shadow-sm p-5"
        >
          <label className="text-sm font-medium text-foreground block mb-3 text-center">
            Enter 6-digit code
          </label>
          <div className="flex justify-center gap-2 mb-4">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={(e) => handleDigitChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className="w-11 h-13 text-center text-xl font-semibold border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
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
              "Verify"
            )}
          </Button>

          <div className="text-center mt-3">
            <button
              type="button"
              onClick={handleSendCode}
              disabled={sending}
              className="text-xs text-primary hover:underline"
            >
              Resend code
            </button>
          </div>
        </motion.div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Back */}
      <Button variant="outline" onClick={onBack} className="rounded-xl">
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back
      </Button>
    </div>
  );
}

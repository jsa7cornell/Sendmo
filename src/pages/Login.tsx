import { useState } from "react";
import { Navigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";

export default function Login() {
  const { session, loading: authLoading, signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already logged in — redirect to dashboard
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (session) return <Navigate to="/dashboard" replace />;

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const showEmailError = tried && !emailValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError(null);

    if (!emailValid) return;

    setSending(true);
    const { error: signInError } = await signIn(email);
    setSending(false);

    if (signInError) {
      // Make common Supabase errors user-friendly
      if (signInError.includes("rate limit")) {
        setError("Too many attempts. Please wait a few minutes and try again.");
      } else if (signInError.includes("invalid") && signInError.includes("email")) {
        setError("Please enter a valid email address.");
      } else {
        setError(signInError);
      }
    } else {
      setSent(true);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-sm"
      >
        {/* Logo / brand */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground">SendMo</h1>
          <p className="text-sm text-muted-foreground mt-1">Prepaid shipping made easy</p>
        </div>

        <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
          <AnimatePresence mode="wait">
            {!sent ? (
              <motion.form
                key="form"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                onSubmit={handleSubmit}
                noValidate
              >
                <h2 className="text-lg font-semibold text-foreground mb-1">Sign in</h2>
                <p className="text-sm text-muted-foreground mb-5">
                  We'll send a magic link to your email
                </p>

                <div className="space-y-2 mb-4">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={`pl-10 rounded-xl ${showEmailError ? "border-destructive" : ""}`}
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                  {showEmailError && (
                    <p className="text-xs text-destructive">Please enter a valid email address</p>
                  )}
                </div>

                {/* Validation summary */}
                <AnimatePresence>
                  {tried && !emailValid && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 mb-4"
                    >
                      <p className="text-xs text-destructive">Enter a valid email to continue</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                {error && (
                  <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 mb-4">
                    <p className="text-xs text-destructive">{error}</p>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={sending}
                  className="w-full rounded-xl shadow-sm gap-2"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ArrowRight className="w-4 h-4" />
                  )}
                  {sending ? "Sending..." : "Send magic link"}
                </Button>
              </motion.form>
            ) : (
              <motion.div
                key="success"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
                className="text-center py-4"
              >
                <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle2 className="w-6 h-6 text-success" />
                </div>
                <h2 className="text-lg font-semibold text-foreground mb-1">Check your email</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  We sent a magic link to <span className="font-medium text-foreground">{email}</span>
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  Click the link in the email to sign in. Check your spam folder if you don't see it.
                </p>
                <button
                  type="button"
                  onClick={() => { setSent(false); setTried(false); setError(null); }}
                  className="text-xs text-primary hover:underline underline-offset-2"
                >
                  Didn't receive it? Try again
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          <a href="/" className="hover:text-foreground transition-colors">
            Back to home
          </a>
        </p>
      </motion.div>
    </div>
  );
}

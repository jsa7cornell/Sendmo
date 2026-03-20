import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Copy, MessageSquare, Mail, ArrowRight, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createFlexLink } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// ─── QR Code placeholder ────────────────────────────────────

function QRPlaceholder({ url }: { url: string }) {
  return (
    <div className="w-40 h-40 mx-auto bg-white rounded-xl border border-border flex items-center justify-center p-3">
      <div className="text-center">
        <div className="grid grid-cols-5 gap-0.5 mx-auto w-20 h-20 mb-2">
          {Array.from({ length: 25 }, (_, i) => (
            <div
              key={i}
              className={`w-full aspect-square rounded-[1px] ${
                [0, 1, 2, 4, 5, 6, 9, 10, 14, 15, 18, 19, 20, 22, 23, 24].includes(i)
                  ? "bg-foreground"
                  : "bg-transparent"
              }`}
            />
          ))}
        </div>
        <p className="text-[8px] text-muted-foreground leading-tight break-all">{url}</p>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
}

export default function RecipientStepLinkReady({ state, onUpdate }: Props) {
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { session } = useAuth();

  // Persist the link to the database on first mount
  useEffect(() => {
    if (state.short_code) return; // Already created
    if (creating) return; // In progress

    async function persistLink() {
      setCreating(true);
      setError(null);

      const token = session?.access_token;
      if (!token) {
        setError("You must be signed in to create a link. Please sign in and try again.");
        setCreating(false);
        return;
      }

      try {
        const result = await createFlexLink({
          recipient_address: {
            name: state.destinationAddress.name,
            street1: state.destinationAddress.street,
            city: state.destinationAddress.city,
            state: state.destinationAddress.state,
            zip: state.destinationAddress.zip,
            verified: state.destinationAddress.verified,
          },
          speed_preference: state.speed_preference,
          preferred_carrier: state.preferred_carrier,
          price_cap_dollars: state.price_cap,
          size_hint: state.size_hint,
          distance_hint: state.distance_hint,
        }, token);

        onUpdate({ short_code: result.short_code });
      } catch (err) {
        console.error("Failed to create link:", err);
        setError(err instanceof Error ? err.message : "Failed to create link. Please try again.");
      } finally {
        setCreating(false);
      }
    }

    persistLink();
  }, [state.short_code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loading state
  if (creating) {
    return (
      <div className="space-y-5 text-center py-12">
        <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />
        <p className="text-lg font-semibold text-foreground">Creating your shipping link…</p>
        <p className="text-sm text-muted-foreground">This only takes a moment</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="space-y-5">
        <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
          <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">Something went wrong</h2>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <Button
            onClick={() => {
              setError(null);
              setCreating(false);
              // Trigger the effect again by ensuring short_code is empty
              onUpdate({ short_code: "" });
            }}
            className="rounded-xl"
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // Not yet created (shouldn't normally show, but safety)
  if (!state.short_code) {
    return null;
  }

  // Success state — link created and persisted
  const shortLink = `sendmo.co/s/${state.short_code}`;
  const fullUrl = `https://${shortLink}`;

  function handleCopy() {
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const smsBody = encodeURIComponent(
    `I set up a prepaid shipping link for you. Use it to send me a package — just click the link, enter your package details, and print the label. No payment needed on your end!\n\n${fullUrl}`,
  );
  const emailSubject = encodeURIComponent("Send me a package with SendMo");
  const emailBody = encodeURIComponent(
    `Hi!\n\nI've set up a prepaid shipping link so you can easily send me a package. Just click the link below, enter your package details, and print the label. No payment needed on your end.\n\n${fullUrl}\n\nThanks!`,
  );

  return (
    <div className="space-y-5">
      {/* Success banner */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-success/10 border border-success/30 rounded-2xl p-6 text-center"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
        >
          <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-3" />
        </motion.div>
        <h2 className="text-xl font-bold text-foreground">Your link is ready!</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Share it with anyone who needs to send you a package.
        </p>
      </motion.div>

      {/* Link + copy */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Your shipping link</h3>
        <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2.5 mb-4">
          <span className="text-sm text-foreground font-mono flex-1 truncate">{shortLink}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="rounded-lg gap-1.5 shrink-0"
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>

        {/* QR Code */}
        <QRPlaceholder url={shortLink} />
      </div>

      {/* Share buttons */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Share with your sender</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            variant="outline"
            className="rounded-xl gap-2"
            onClick={() => window.open(`sms:?body=${smsBody}`, "_self")}
          >
            <MessageSquare className="w-4 h-4" />
            Text
          </Button>
          <Button
            variant="outline"
            className="rounded-xl gap-2"
            onClick={() =>
              window.open(`mailto:?subject=${emailSubject}&body=${emailBody}`, "_self")
            }
          >
            <Mail className="w-4 h-4" />
            Email
          </Button>
        </div>
      </div>

      {/* Link preferences summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Link preferences</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Speed</dt>
            <dd className="font-medium text-foreground capitalize">{state.speed_preference}</dd>
          </div>
          {state.preferred_carrier && state.preferred_carrier !== "any" && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Carrier</dt>
              <dd className="font-medium text-foreground uppercase">{state.preferred_carrier}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Price cap</dt>
            <dd className="font-medium text-foreground">${state.price_cap}</dd>
          </div>
        </dl>
      </div>

      {/* CTA */}
      <Button
        className="w-full rounded-xl shadow-sm gap-2"
        onClick={() => (window.location.href = "/dashboard")}
      >
        Go to your account page
        <ArrowRight className="w-4 h-4" />
      </Button>
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { Package2, MapPin, Printer, ArrowRight } from "lucide-react";
import type { LinkData } from "@/lib/api";

interface Props {
  linkData: LinkData;
  onContinue: () => void;
}

// SPEC §8 Step 0. "You're sending a package to {recipientName}".
// City/state is the only location detail shown — Rule 7: never show street/zip
// in sender UI text. The printed label is the only address surface.
export default function SenderStepIntro({ linkData, onContinue }: Props) {
  const recipientName = linkData.recipient_name?.trim() || null;
  const headline = recipientName
    ? `You're sending a package to ${recipientName}`
    : "You're sending a package via this prepaid link";

  const cityState = linkData.recipient_city && linkData.recipient_state
    ? `${linkData.recipient_city}, ${linkData.recipient_state}`
    : null;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
          SendMo Label Link
        </span>
        <h1 className="text-2xl font-bold text-foreground">{headline}</h1>
        {cityState && (
          <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-sm">
            <MapPin className="w-3.5 h-3.5" /> Shipping to {cityState}
          </p>
        )}
      </div>

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">How it works</h3>
        <ol className="space-y-3">
          {[
            { icon: Package2, text: "Tell us about your package" },
            { icon: ArrowRight, text: "Choose a shipping method" },
            { icon: Printer, text: `Print the label and ship${recipientName ? ` — ${recipientName} already paid` : " — shipping is prepaid"}` },
          ].map((step, i) => {
            const Icon = step.icon;
            return (
              <li key={i} className="flex items-start gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">
                  {i + 1}
                </span>
                <div className="flex-1 flex items-center gap-2">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-foreground">{step.text}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <Button
        onClick={onContinue}
        className="w-full rounded-xl shadow-sm text-base py-6"
      >
        Get Started
        <ArrowRight className="w-4 h-4 ml-1" />
      </Button>
    </div>
  );
}

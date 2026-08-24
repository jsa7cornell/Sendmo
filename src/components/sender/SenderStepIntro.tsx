import { Button } from "@/components/ui/button";
import { Package2, MapPin, Printer, Truck, ArrowRight } from "lucide-react";
import type { LinkData } from "@/lib/api";
import { displayName } from "@/lib/name";
import type { SenderQuestion } from "./senderState";

interface Props {
  linkData: LinkData;
  /** The questions this link actually leaves open — see planSenderSteps. */
  questions: SenderQuestion[];
  onContinue: () => void;
}

// SPEC §8 Step 0. City/state is the only location detail shown — Rule 7:
// never show street/zip in sender UI text. The printed label is the only
// address surface.
//
// 2026-08-24: "How it works" lists the steps THIS link has, not a fixed three.
// A link whose creator specced the parcel and the ship-from address was still
// promising "tell us about your package" — and then showed a screen of
// pre-answered fields to back the promise up.
export default function SenderStepIntro({ linkData, questions, onContinue }: Props) {
  const recipientName = displayName(linkData.recipient_name);
  const headline = linkData.needs_destination
    ? "You're sending a package — you choose where it goes"
    : recipientName
      ? `You're sending a package to ${recipientName}`
      : "You're sending a package via this prepaid link";

  // One line per question the sender will actually be asked, then the two
  // steps every sender has.
  const questionLines: Record<SenderQuestion, { icon: typeof Package2; text: string }> = {
    destination: { icon: MapPin, text: "Tell us where it's going" },
    origin: { icon: MapPin, text: "Tell us where it's shipping from" },
    package: { icon: Package2, text: "Tell us about your package" },
  };
  const steps = [
    ...questions.map((q) => questionLines[q]),
    { icon: Truck, text: "Choose a shipping method" },
    {
      icon: Printer,
      text: `Print the label and ship${recipientName ? ` — ${recipientName} already paid` : " — shipping is prepaid"}`,
    },
  ];

  // Said once, up front: the creator already answered everything else.
  const alreadySet = questions.length === 1
    ? "Everything else is already set."
    : questions.length === 0
      ? "Everything is already set."
      : null;

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
        {alreadySet && <p className="text-sm text-muted-foreground">{alreadySet}</p>}
      </div>

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">How it works</h3>
        <ol className="space-y-3">
          {steps.map((step, i) => {
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

import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";
import { loadSavedSender } from "@/components/sender/senderState";

interface Props {
  // Layered visibility signal (per author-response B4):
  //   show iff (?fresh=1) ∨ (anonymous + localStorage) ∨ (authenticated AND !viewer_is_recipient)
  //   hide iff (authenticated AND viewer_is_recipient)
  isFresh: boolean;
  isAuthenticated: boolean;
  viewerIsRecipient: boolean;
  linkShortCode: string | null;
  recipientName: string | null;
}

export function shouldShowShipAgain({
  isFresh,
  isAuthenticated,
  viewerIsRecipient,
  hasSavedSender,
  linkShortCode,
}: {
  isFresh: boolean;
  isAuthenticated: boolean;
  viewerIsRecipient: boolean;
  hasSavedSender: boolean;
  linkShortCode: string | null;
}): boolean {
  // Need a link short_code to build the CTA's destination.
  if (!linkShortCode) return false;
  // The recipient (authenticated link owner) doesn't see this — Dashboard
  // is their surface for managing the link.
  if (isAuthenticated && viewerIsRecipient) return false;
  // Just-shipped guarantee — always show.
  if (isFresh) return true;
  // Anonymous viewer with a saved sender profile on this device.
  if (!isAuthenticated && hasSavedSender) return true;
  // Authenticated viewer who is NOT the recipient (future signed-in-sender case).
  if (isAuthenticated && !viewerIsRecipient) return true;
  return false;
}

// "Ship another package to {recipient}" upsell on /t/<public_code>.
// Visibility per the layered signal above. Pre-fills the sender's address
// via the existing localStorage round-trip in SenderFlow.
export default function ShipAgainCTA({
  isFresh, isAuthenticated, viewerIsRecipient, linkShortCode, recipientName,
}: Props) {
  const hasSavedSender = loadSavedSender() !== null;
  const show = shouldShowShipAgain({
    isFresh, isAuthenticated, viewerIsRecipient, hasSavedSender, linkShortCode,
  });
  if (!show || !linkShortCode) return null;

  const name = recipientName?.trim() || "the same recipient";

  return (
    <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Send className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Ship another package to {name}?</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            We'll pre-fill your address. Just confirm what's in the box.
          </p>
          <Link to={`/s/${linkShortCode}`} className="block mt-3">
            <Button size="sm" className="rounded-xl">
              Ship another
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

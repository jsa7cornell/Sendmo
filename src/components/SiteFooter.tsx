import { Link } from "react-router-dom";
import SendMoLogo from "@/components/SendMoLogo";

/**
 * Shared site footer. Lives on every user-facing page (the marketing page,
 * the flows, the dashboard, the legal pages) so the brand + legal links are
 * reachable from anywhere. Deliberately absent from the print surface
 * (/t/:code/print) and the internal admin pages.
 *
 * `mt-auto` pins it to the bottom on short pages when the page shell is a
 * `min-h-screen flex flex-col`; it's inert otherwise.
 */
export default function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-card">
      <div className="container max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <SendMoLogo className="w-5 h-5" />
          <span className="text-sm text-muted-foreground">SendMo — Prepaid shipping made easy</span>
        </Link>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link to="/faq" className="hover:text-foreground transition-colors">FAQ</Link>
          <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
          <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
          <a href="mailto:support@sendmo.co" className="hover:text-foreground transition-colors">Support</a>
        </div>
      </div>
    </footer>
  );
}

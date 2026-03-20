import { useState } from "react";
import { Package, LogOut, User, ChevronDown, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function HeaderPreview() {
  const [signedIn, setSignedIn] = useState(true);

  return (
    <div className="min-h-screen bg-muted/50">
      {/* State toggle */}
      <div className="bg-card border-b border-border py-4 px-4 text-center">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
          Header Preview — Option B
        </p>
        <div className="flex gap-2 justify-center">
          {[true, false].map((state) => (
            <button
              key={String(state)}
              onClick={() => setSignedIn(state)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                signedIn === state
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/40"
              }`}
            >
              {state ? "Signed In" : "Signed Out"}
            </button>
          ))}
        </div>
      </div>

      <HeaderB signedIn={signedIn} />

      <div className="container max-w-md mx-auto py-12 px-4 text-center">
        <p className="text-muted-foreground text-sm">Page content below header…</p>
      </div>
    </div>
  );
}

function HeaderB({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="border-b border-border bg-card">
        <div className="container max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-primary" />
            <span className="text-lg font-bold text-foreground">SendMo</span>
          </div>

          {signedIn ? (
            <div className="relative">
              <button
                onClick={() => setOpen(!open)}
                className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors px-2 py-1.5 rounded-lg hover:bg-muted/50"
              >
                <User className="w-4 h-4 text-muted-foreground" />
                John
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
              {open && (
                <div className="absolute right-0 top-11 w-48 bg-card rounded-xl border border-border shadow-lg py-1 z-50">
                  <button className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-muted/50 flex items-center gap-2.5">
                    <Settings className="w-4 h-4 text-muted-foreground" />
                    My Account
                  </button>
                  <div className="border-t border-border my-1" />
                  <button className="w-full text-left px-4 py-2.5 text-sm text-destructive hover:bg-destructive/5 flex items-center gap-2.5">
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="rounded-xl text-sm"
              >
                FAQ
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl text-sm"
              >
                Sign In
              </Button>
            </div>
          )}
        </div>
      </header>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
    </>
  );
}

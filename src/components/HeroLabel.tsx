// A stylized 4×6 shipping label for the homepage hero — the thing both doors
// produce, drawn in CSS so it stays crisp at every density and ships no image
// asset. Decorative: aria-hidden, fixed proportions (no CLS), always
// light-on-white like a real label regardless of theme. Hidden below lg — the
// mobile hero keeps the clean two-card stack. No capability claims on it
// (John, 2026-08-31: a printer IS needed — the label carries no "no printer"
// copy, just what a label looks like).
export default function HeroLabel() {
  return (
    <div aria-hidden className="hidden lg:flex items-center justify-center">
      <div className="w-[210px] rotate-[3.5deg] rounded-md border border-neutral-300 bg-white text-neutral-900 shadow-xl overflow-hidden font-sans">
        {/* Service banner */}
        <div className="flex items-center gap-2 border-b-2 border-neutral-900 px-2.5 py-2">
          <span className="text-2xl font-extrabold leading-none">P</span>
          <div className="text-[9px] font-bold leading-snug tracking-wide">
            USPS PRIORITY MAIL®
            <br />
            <span className="font-normal">POSTAGE PAID · SENDMO</span>
          </div>
        </div>

        {/* Addresses */}
        <div className="px-2.5 pt-2 pb-1 uppercase leading-relaxed">
          <div className="text-[8px] text-neutral-500">
            From: John A · Portola Valley CA 94028
          </div>
          <div className="mt-1.5 text-[10.5px] font-bold leading-snug">
            SHIP TO:
            <br />
            JIMY RIVERA
            <br />
            417 ELM AVE
            <br />
            ELYRIA OH 44035
          </div>
        </div>

        {/* Tracking barcode */}
        <div className="px-2.5 pb-2.5 pt-1.5">
          <div className="mb-1 text-[7.5px] font-bold tracking-wider">USPS TRACKING #</div>
          <div
            className="h-8"
            style={{
              background:
                "repeating-linear-gradient(90deg,#171717 0 2px,transparent 0 4px,#171717 0 5px,transparent 0 9px,#171717 0 12px,transparent 0 14px)",
            }}
          />
          <div className="mt-1 text-center font-mono text-[8.5px] tracking-wider">
            9405 5036 9930 0012 3456 78
          </div>
        </div>
      </div>
    </div>
  );
}

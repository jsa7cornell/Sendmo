import { SENDER_STEP_ORDER, type SenderStep } from "./senderState";

// 5-dot progress bar for the sender wizard. Non-clickable per SPEC §8 line 432.
// Intro step renders no bar (the welcome screen is its own moment).
export default function SenderProgressBar({ step }: { step: SenderStep }) {
  if (step === "intro") return null;

  const currentIdx = SENDER_STEP_ORDER.indexOf(step);

  return (
    <nav aria-label="Progress" className="flex items-center justify-center gap-2 mb-6">
      {SENDER_STEP_ORDER.map((s, i) => {
        if (s === "intro") return null;
        const isDone = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <span
            key={s}
            aria-current={isCurrent ? "step" : undefined}
            className={
              "h-2 rounded-full transition-all " +
              (isCurrent
                ? "w-8 bg-primary"
                : isDone
                  ? "w-2 bg-primary"
                  : "w-2 bg-muted")
            }
          />
        );
      })}
    </nav>
  );
}

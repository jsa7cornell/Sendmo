import { cn } from "@/lib/utils";

// Dim-in-place, from the design handoff: "Choosing 'Sender fills this in'
// does not swap the screen for a large colored panel; the field group simply
// dims (opacity ~0.4, pointer-events off) in place, so nothing else in the
// layout shifts."
//
// The layout stability is the point. The pattern this replaces removed the
// form and rendered a panel of different height, so answering the question
// moved everything below it — including the Continue button the user was
// reaching for.
//
// `inert` is what actually takes the subtree out of reach: it removes
// descendants from the tab order AND from the accessibility tree, so a
// screen-reader user cannot land inside a field that the sighted UI is
// showing as inactive. `pointer-events: none` alone would leave both.
// `aria-hidden` is deliberately NOT used — `inert` already hides the subtree,
// and doubling up risks hiding a focused element, which is its own bug.

interface Props {
  deferred: boolean;
  children: React.ReactNode;
}

export default function DimmedWhenDeferred({ deferred, children }: Props) {
  return (
    <div
      // React 19 takes `inert` as a real boolean prop. An earlier cut passed
      // `inert=""` for older typings; React 19 drops that, so the subtree was
      // faded but still fully reachable by keyboard and screen reader — the
      // failure this component exists to prevent. Pinned by skip-toggle.spec.
      inert={deferred}
      className={cn(
        "transition-opacity duration-200",
        deferred && "opacity-40 pointer-events-none select-none",
      )}
    >
      {children}
    </div>
  );
}

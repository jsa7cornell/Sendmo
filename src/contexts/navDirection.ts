// This two-line module exists for rule-scoping, not abstraction: react-hooks/refs
// data-flow-tracks a direct `.current` read through every downstream use in the
// reading file, so RecipientFlowContext's one sanctioned render-time read (the
// `direction` context value) produced TWO findings there and could only be
// silenced file-wide. Routing the read through this module narrows the rule's
// flag to the single call-site line, which carries the one documented
// eslint-disable — the rule stays armed for the rest of the 400-line provider.
// Do not add other callers.
export function readNavDirection<T>(ref: { current: T }): T {
  return ref.current;
}

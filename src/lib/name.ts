// ─── Display formatting for person names ───────────────────────────────────
//
// Names are typed casually at onboarding ("john anderson"), then shown to
// someone else entirely — the sender reading "You're sending a package to
// john anderson", or the WhatsApp/iMessage link preview. Capitalise them for
// display only; the stored value and the printed shipping label keep whatever
// the recipient entered.
//
// Dependency-free on purpose: src/lib/ogMeta.ts pulls this into the Vercel
// Edge Middleware bundle.

// Only all-lowercase segments are touched, which leaves deliberate casing
// alone (McDonald, DeLuca, JAY). Splits on spaces, hyphens and apostrophes:
// "mary-jane o'brien" → "Mary-Jane O'Brien".
export function titleCaseName(name: string): string {
  return name
    .trim()
    .replace(/[^\s\-']+/g, (word) =>
      /[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)
    );
}

// Convenience for the common "raw field → display string or null" shape.
export function displayName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? titleCaseName(trimmed) : null;
}

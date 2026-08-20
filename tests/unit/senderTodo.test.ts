import { describe, it, expect } from "vitest";
import { senderTodoSentence, CHARGE_NOTE } from "@/lib/senderTodo";

const d = (destination = false, origin = false, pkg = false) =>
  ({ destination, origin, package: pkg });

describe("senderTodoSentence", () => {
  it("covers all seven deferred combinations with a distinct sentence", () => {
    const seen = new Set<string>();
    for (const dest of [true, false]) for (const o of [true, false]) for (const p of [true, false]) {
      const out = senderTodoSentence(d(dest, o, p));
      if (!dest && !o && !p) { expect(out).toBeNull(); continue; }
      expect(out).not.toBeNull();
      seen.add(out!);
    }
    expect(seen.size).toBe(7);
  });

  it("names the person rather than saying 'they' with no antecedent", () => {
    for (const dest of [true, false]) for (const o of [true, false]) for (const p of [true, false]) {
      const out = senderTodoSentence(d(dest, o, p));
      if (out) expect(out.startsWith("The person printing the label will")).toBe(true);
    }
  });

  it("returns null for a fully-specced label — there is no outstanding work", () => {
    expect(senderTodoSentence(d(false, false, false))).toBeNull();
  });

  it("never claims a lifetime cap — that promise was false and was removed", () => {
    // The cap bounds each USE, not the link. A link used three times bills
    // three times, so "never more" was a promise the system does not keep.
    expect(CHARGE_NOTE).not.toMatch(/never more/i);
    expect(CHARGE_NOTE).not.toMatch(/\$/);
    expect(CHARGE_NOTE).toBe("We'll charge your card once they ship.");
  });

  it("describes only what was actually deferred", () => {
    expect(senderTodoSentence(d(false, true, false))).toMatch(/ship-from address\.$/);
    expect(senderTodoSentence(d(false, true, false))).not.toMatch(/package/i);
    expect(senderTodoSentence(d(false, false, true))).toMatch(/describe the package\.$/);
    expect(senderTodoSentence(d(false, false, true))).not.toMatch(/address/i);
  });
});

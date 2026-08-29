import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// PR6 (seller-link launch, review Pitfall 2): the delivery webhook's
// in_use → completed flip and cancel-label's Stage-4 revival must NEVER
// touch a seller link — a delivered sale must not close a listing (the PR5
// off switch is the seller's alone) and a cancelled sale must not re-open a
// sold single-use link (no-auto-reopen is decided).
//
// Both writers are INERT for seller links today only because
// shipments.link_id points at a throwaway full_label link. PR11 repoints
// link_id at the REAL seller link, at which point these guards become
// load-bearing. "PR6 must land before PR11" was a remembered ordering;
// this test makes it mechanical: if either .neq guard is removed (or PR11
// lands in a tree where it never existed), this fails in CI.
//
// Source-contract test on purpose: the edge functions call Deno.serve at
// module load, so their handlers are unreachable from Vitest — asserting
// the guard's presence in source is the deterministic alternative to not
// testing it at all (PLAYBOOK Rule 19's "name the tighter alternative").

function functionSource(name: string): string {
  return readFileSync(
    resolve(process.cwd(), `supabase/functions/${name}/index.ts`),
    "utf-8",
  );
}

/**
 * The status-write chains that may not touch seller links.
 *
 * Known residual limits (reviewed, accepted): the regex is table-agnostic —
 * it keys on the status literal, so (a) a future update({status:"active"})
 * on a DIFFERENT table in cancel-label would fail here demanding a nonsense
 * guard (annoying, fails safe), and (b) a future variable-object link-status
 * writer (update(fields)) alongside these would be invisible to it. Anyone
 * adding a sendmo_links status writer: extend this test.
 */
function statusWriteChains(src: string, statusLiteral: string): string[] {
  // A chain is the update({ status: ... }) call plus its filter methods.
  const chains: string[] = [];
  const re = new RegExp(
    String.raw`\.update\(\{\s*status:\s*"${statusLiteral}"[^}]*\}\)[\s\S]{0,400}?;`,
    "g",
  );
  for (const m of src.matchAll(re)) chains.push(m[0]);
  return chains;
}

describe("seller-link lifecycle guards (must exist before PR11 repoints shipments.link_id)", () => {
  it("webhooks: every sendmo_links 'completed' flip excludes seller links", () => {
    const src = functionSource("webhooks");
    const chains = statusWriteChains(src, "completed");
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      // Positive scoping (PR11 review #6): .eq full_label, not
      // .neq seller_link — the .neq form left flex links protected only by
      // the "flex is never in_use" convention, enforced nowhere.
      expect(chain).toContain(`.eq("link_type", "full_label")`);
    }
  });

  it("cancel-label: every sendmo_links 'active' revival is scoped to full-label viewer links", () => {
    const src = functionSource("cancel-label");
    const chains = statusWriteChains(src, "active");
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain).toContain(`.eq("link_type", "full_label")`);
    }
  });

  it("labels: the single-use reopen stays scoped to the REAL seller link by id (the one legitimate seller-link revival)", () => {
    // labels' buy-failure reopen targets resolvedLink.id under an explicit
    // link_type === "seller_link" branch — that one is CORRECT and must not
    // grow a .neq guard by copy-paste.
    const src = functionSource("labels");
    expect(src).toContain(`resolvedLink?.link_type === "seller_link" && resolvedLink.max_shipments === 1`);
  });
});

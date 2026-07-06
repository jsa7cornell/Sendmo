// _shared/background.ts
//
// runInBackground — keep post-response async work alive on the Supabase
// edge runtime. Without EdgeRuntime.waitUntil, promises still pending when
// the handler returns may be cut off when the isolate is reclaimed — the
// 2026-06-27 label_created email bug class. One shared wrapper (Rule 6).
//
// Falls back to a detached catch under Vitest/Node (no EdgeRuntime global)
// and on any runtime where waitUntil is unavailable.

type WaitUntilRuntime = { waitUntil: (p: Promise<unknown>) => void };

export function runInBackground(task: Promise<unknown>, label: string): void {
    const guarded = task.catch((err) => {
        console.error(`[background:${label}]`, err instanceof Error ? err.message : String(err));
    });
    const er = (globalThis as { EdgeRuntime?: WaitUntilRuntime }).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") {
        er.waitUntil(guarded);
    }
    // No waitUntil available (tests / local serve): the detached catch above
    // is the best we can do; callers must not rely on completion.
}

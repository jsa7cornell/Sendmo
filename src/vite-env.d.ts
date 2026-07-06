/// <reference types="vite/client" />

// Injected by vite.config.ts `define` at build time (T1-3 monitoring).
// Always strings (JSON.stringify of Vercel build vars, "" locally).
// Guard reads with `typeof x !== "undefined"` — vitest.config.ts has no
// `define`, so a bare reference would throw under unit tests.
declare const __APP_RELEASE__: string;
declare const __APP_ENV__: string;

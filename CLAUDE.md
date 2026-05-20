# Claude Harness — SendMo

> **Claude agents: this file is your entry point for SendMo work.**

## Read These Files (in order)

1. **`../CLAUDE.md`** — Brain-level entry point (loads global Playbook, User profile, Registry)
2. **`../GLOBAL-PLAYBOOK.md`** — universal session norms (start/wrap protocol, preview-before-merge, concurrent-agent safety)
3. **`PLAYBOOK.md`** — SendMo project instructions, tech stack, architecture, rules
4. **`SPEC.md`** — product requirements, flows, acceptance criteria
5. **`LOG.md`** — decisions, integration gotchas, deploy history

## Claude-Specific Notes

- **Skills** live in `../.claude/skills/` — check for relevant skills before creating documents.
- **Testing:** `TESTING.md` is the one-page map of all four test layers (unit / integration / e2e / browser-verify) — read it before any test work.
- **Session end protocol**: propose updates to LOG.md or PLAYBOOK.md for anything new discovered. If nothing changed, say "No doc updates needed this session."

## Agent-Agnostic Note

This harness exists because Claude looks for `CLAUDE.md` automatically. The actual project instructions live in `PLAYBOOK.md` (shared with all AI tools).

---

*Last updated: 2026-05-20 — added TESTING.md pointer.*

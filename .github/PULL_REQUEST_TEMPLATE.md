## Problem / bug this fixes

<!-- One paragraph. A PR without a stated bug or limitation is a PR a
     reviewer cannot judge. -->

## What changed

<!-- Bullet list, grouped by area. -->

## How it was verified

<!-- Real commands you ran and their result. Not "should work". -->

- [ ] `make test` (backend pytest) green
- [ ] `make test-frontend` + `npx tsc --noEmit` + `npm run build` green
- [ ] `cargo fmt --check` / `clippy -D warnings` / `cargo test` green
      (both crates) — *if anything Rust was touched*

## Invariants consciously preserved

<!-- Delete the ones that don't apply, keep the ones that do: -->

- No test or CI step hits a network provider API (offline test suite).
- Wire format changes touch `api/ws_codec.py` AND `frontend/src/lib/codec.ts`.
- Paper broker: market orders validate before any DB write (no ghosts);
  positions never short.
- Alert timers stay keyed per rule; `time_*` cooldown=hold-seconds semantics
  documented where used.
- Rust runtime answers unimplemented paths with honest UNSUPPORTED, not
  fabricated success/status.

## Notes for review / known gaps

<!-- Half-migrations, deferred edge cases, docs left stale on purpose —
     say it here or it will be rediscovered painfully. -->

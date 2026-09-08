# Contributing to OpenTerm

Local-first, single-user, honest-above-all. That last part is the actual
convention this repo defends: when something cannot be done safely or
truthfully, the code says UNSUPPORTED rather than inventing a success.
Keep it that way.

## Setup

```bash
make install          # .venv + editable backend + frontend npm deps
make dev              # backend :8000 + Vite :5173 + Electron
make serve            # single-process prod-style on :8765
```

Optional: Rust toolchain for `bot-runtime/` + `bot-protocol/` (see their
README — the runtime executes nothing yet, and PRs "making it work" must
start by reading `bot-runtime/README.md`).

## Style

- **Python** ≥3.12 idioms, type hints, no `print` in library code (logging).
  Providers must not require a key to import; missing keys degrade to red
  status dots, never crashes.
- **TypeScript**: strict, `noUnused*` is ON, no `any` escapes for JSX.
  `npx tsc --noEmit` must stay clean. WS wire changes go through
  `api/ws_codec.py` **and** `frontend/src/lib/codec.ts` in one commit.
- **Rust**: `cargo fmt` + `cargo clippy -D warnings` clean, both crates.
- Comments explain WHY (history, traps, deliberate choices), never what.
  Several files carry long "history that will get you burned" notes — they
  are load-bearing documentation, read them before editing those files.

## Testing obligation per language

Every fix ships with a regression test that fails without it. There is a
whole file (`backend/tests/`) of tests named after the bugs they pin.

| Area | Command | Bar |
|---|---|---|
| Backend | `make test` | pytest green; new code needs tests |
| Frontend | `make test-frontend` + `cd frontend && npx tsc --noEmit && npm run build` | vitest green, clean typecheck |
| Rust | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` in both crates | zero warnings |

Tests are **offline**: provider tests mock transports (see
`tests/test_oanda.py` etc.). Nothing may dial a network API from CI — the
GitHub workflow has no secrets and must stay that way.

## Pull requests

- One problem per PR. Describe the *bug or limitation*, not just the change.
- If you touch the paper broker, alert engine, WS protocol, or anything in
  `bot-runtime/`, say which invariants you preserved (ghost-order-free
  submits, per-rule alert timers, byte-exact codec parity, honest UNSUPPORTED).
- Update `docs/ARCHITECTURE.md` / `docs/COMMANDS.md` / `CHANGELOG.md` when
  behavior or the wire format changes.
- Never introduce secrets, telemetry, or outbound calls that aren't a
  user-configured provider.

## Known debt you should NOT accidentally "fix" back

Float-based paper money (deliberate), `cooldown` doubling as hold-seconds for
`time_*` alerts (documented overload pending a migration), the bot registry
persisting rows with no engine (labeled EXPERIMENTAL), ` tif="day"` not
auto-cancelling. Deleting their warning comments to make code "cleaner" is
the regression.

## License

By contributing you license your contribution under Apache-2.0.

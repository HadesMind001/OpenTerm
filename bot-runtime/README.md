# OpenTerm Bot Runtime — **EXPERIMENTAL SKELETON**

Read this before you contribute, demo, or — worst case — *depend* on anything
in this directory.

**What this is:** a wasmtime-based host *scaffolding* for sandboxed trading
bots. It compiles. `cargo test` is green (15 runtime + 3 protocol tests),
`cargo clippy -D warnings` is clean. That is the complete list of things it
does.

**What this is NOT:** a runtime that executes bots. Concretely:

* No loader can produce a working wasm guest (see *Contributing: loaders*).
* `order_place` returns an explicit UNSUPPORTED error — the old code returned
  a fabricated order uuid from a MockOrderRouter. A trading system inventing
  fills is the worst class of bug; it will not come back.
* The transport answers everything except `Ping` with an honest
  `Unsupported` error. No fabricated `GetStatus → Running`. Never will.
* The Python app (`backend/openterm/services/bot_manager.py`) does not talk
  to this binary. The bot registry in the UI lists, starts, and stops
  *database rows* and nothing else.
* Nothing in `make dev` / `make serve` / the Electron shell launches
  `openterm-bot`.

## Layout

```
bot-protocol/        the wire + manifest types (single source of truth)
bot-runtime/
  src/
    lib.rs           crate facade (main.rs is a thin binary wrapper)
    error.rs         BotRuntimeError (thiserror); InvalidConfig/NotImplemented
    manifest.rs      re-export shim -> openterm-bot-protocol (do not add types)
    transport.rs     Unix-socket JSON-lines server/client (tokio)
    runtime/
      instance.rs    one wasmtime store: env.* ABI, fuel, limits, persistence
      guardrails.rs  RiskGuard: pure logic over CapabilityManager state
    host/
      capabilities.rs  kill switches, rate window, symbol/pnl checks
      limits.rs        check-before-mutate resource accounting
      fuel.rs          wasmtime engine + fuel metering
      persistence.rs   sqlx/SQLite KV for guests (LIKE-ESCAPE, namespaced)
      api.rs           host-side value types (Bar/Fill/Quote/...)
    loader/
      mod.rs           LanguageLoader trait + get_loader() dispatch
      javascript.rs    errors honestly (esbuild cannot emit wasm)
      python.rs        py2wasm discovery, no unwrap
      rust.rs          cargo-build wrapper — see security note below
      assemblyscript.rs
    cli/               `openterm-bot` clap CLI; unwired commands exit 1
```

### Type ownership (the four-copies disease, cured)

`Trade`/`BotConfig`/`BotStats`/`Display`/`check_symbol_allowed` live **only**
in `bot-protocol`. The runtime re-exports them (`manifest.rs` is a shim).
Known debt: `backend/openterm/services/bot_manager.py` still keeps its own
Python dataclasses mirroring these. They agree today; nothing enforces they
agree tomorrow. When you wire the app to the runtime, generate or share the
schema instead of hand-copying fields again.

### The ABI

Guests import host functions from the module **`"env"`** and export `memory`
plus lifecycle functions (`on_start`, `on_bar`, `on_quote`, `on_trade`,
`on_fill`, `on_timer`, `on_signal`). There used to be a second, parallel
host-function table under `"host"` (`runtime/callbacks.rs` — deleted) with
different signatures; any guest written against it is garbage. Nothing yet
*validates* that a module imports only from `env` — do not treat instantiation
as an approval gate.

String reads from guest memory use checked arithmetic (guest-controlled
`ptr`/`len` as i32 once overflowed a bounds check on debug builds). Keep it
that way.

### Transport security posture

`transport.rs` refuses to bind over anything that is not a stale socket
(the old code `unlink`ed any path — arbitrary file deletion on collision),
chmods the socket to **0600**, and caps inbound lines at 1 MiB. The socket is
**unauthenticated**: anyone with filesystem access to the path can talk to the
runtime. Today the only answer is Pong; the day order routing exists, that
same stranger can place trades. Design auth before wiring anything real.

## Contributing: loaders

A loader is `source -> wasm bytes`. Three of the four currently cannot do
that, and the honest ones error instead of lying:

* **JavaScript:** dead end until a real JS→wasm pipeline exists (Javy, a
  workerd-style embedding, or AssemblyScript for the typed subset) **plus** a
  guest that exports the `env.*` lifecycle ABI. `esbuild --target=wasm` was
  invented here once already; esbuild has no wasm target. Don't re-invent it.
* **Rust:** `rust.rs` shells out to `cargo build` **on the deploy host**.
  That is remote code execution with extra steps whenever the deployed source
  is not yours (build.rs runs arbitrary code before wasm is even involved).
  `package_name` parsing is defensive, and the RCE comment in the file is a
  *constraint*, not a TODO to delete. Never wire this loader to network-
  supplied code without a hermetic build environment.
* **Python / AssemblyScript:** py2wasm-detection and asc-invocation are
  best-effort scaffolding; no guarantee any produced module satisfies the
  `env` ABI, because no produced module has ever existed yet.

If you add a language: implement `LanguageLoader`, make `compile()` either
emit a real module or return a loud error, add a loader test, and update this
README. A loader that returns Ok on garbage is worse than no loader.

## Roadmap (order matters — honesty first, features second)

1. CI jobs for both crates (fmt/clippy/test already pass locally).
2. A *real* guest: the smallest hand-written wasm module (wat is fine) that
   exports the lifecycle functions and calls one `env.*` import; instantiate
   it in an integration test (`Deploy -> Start -> on_bar -> fill path`).
3. Validate the ABI at instantiation time (imports only from `env`, exports
   present with right signatures).
4. A real `OrderRouter` behind `order_place`, with the Python broker as the
   only fill source — then, and only then, delete the UNSUPPORTED errors.
5. Socket authentication (peer-cred or a token file) before any deployment
   story.
6. Schema sharing with the Python side (kill the dataclass copies).

## Build & test

```sh
cd bot-runtime
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                # runtime crate

cd ../bot-protocol
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                # protocol crate
```

Standalone workspaces on purpose (each has its own `[workspace]`): a
root-level workspace appearing later must not silently merge their lockfiles.

## License & author

Apache-2.0 — see `../LICENSE`. Author: Franz Mayer.

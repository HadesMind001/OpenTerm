//! The crate's single error type. `Result<T>` here is
//! `std::result::Result<T, BotRuntimeError>` and crosses every internal
//! boundary. At the raw wasm FFI edge the host functions do NOT return this —
//! they return i32 codes from `runtime/instance.rs::rc`, and
//! `BotInstance::deny_reason` collapses a `BotRuntimeError` into one. Read the
//! variants in three honesty tiers, because a caller (and the guest) need to
//! know which kind of "no" they got:
//!
//!   * GUEST MISBEHAVED — the wasm guest broke the ABI or trapped. At the i32
//!     boundary that is `rc::NO_MEMORY` (guest exported no `memory`) and the
//!     "" that `mem_str` hands back for an out-of-range/negative guest
//!     ptr/len; the typed-Result form is a `Wasm(..)` trap raised while
//!     CALLING the guest (out of fuel, illegal access, guest panic). The guest
//!     author owns these; retrying is pointless.
//!   * HOST REFUSED (policy) — the host COULD serve the call but a guardrail
//!     said no: `CapabilityDenied` (symbol / order permission / signals),
//!     `KillSwitch` (a risk limit tripped), `ResourceLimitExceeded` (rate /
//!     notional / memory budget). `deny_reason` maps `CapabilityDenied` and
//!     `KillSwitch` to `rc::DENIED`. WARNING: that mapping is COARSE today —
//!     `ResourceLimitExceeded` falls through to `rc::UNSUPPORTED` even though
//!     it is conceptually a refusal; tighten it when the boundary is wired, do
//!     not trust the code to distinguish them yet.
//!   * NOT IMPLEMENTED YET (the EXPERIMENTAL honesty tier) — `NotImplemented`:
//!     a deliberate loud refusal standing in for fake success. It is the
//!     typed-Result sibling of the `rc::UNSUPPORTED` codes returned because no
//!     OrderRouter / MarketData / timer is wired, and it is what every unwired
//!     CLI command raises. This is the "honest empty" variant (see
//!     bot-runtime/README.md) — the runtime refusing to pretend, not a bug.
//!
//! The rest is plumbing and deployment, not the tiers above: the `#[from]`
//! variants (`Io`, `Wasm`, `Database`, `Serialization`) are raised by any `?`
//! on an underlying library and describe infra, not policy — `Wasm` in
//! particular doubles as the load/instantiate failure path (a bad module is
//! infra) versus a mid-run trap (the guest), per the first tier.
//! `InvalidManifest` / `BotNotFound` / `BotAlreadyRunning` are input/lifecycle
//! problems, `CompilationFailed` is a loader outcome, and `HostApi(..)` is a
//! reserved catch-all that nothing constructs yet.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum BotRuntimeError {
    #[error("WASM error: {0}")]
    Wasm(#[from] wasmtime::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Bot not found: {0}")]
    BotNotFound(String),

    #[error("Bot already running: {0}")]
    BotAlreadyRunning(String),

    #[error("Capability denied: {0}")]
    CapabilityDenied(String),

    #[error("Resource limit exceeded: {0}")]
    ResourceLimitExceeded(String),

    #[error("Kill switch triggered: {0}")]
    KillSwitch(String),

    #[error("Invalid manifest: {0}")]
    InvalidManifest(String),

    /// A value was readable but wrong or unsafe to act on — a *decision*, not
    /// an I/O failure. Separate from `Io` on purpose: `Io` is the ambient
    /// `#[from] std::io::Error` that any `?` can raise when a syscall fails,
    /// whereas `InvalidConfig` is raised deliberately when the bytes were fine
    /// but the answer is unacceptable. transport.rs is the live example: a
    /// socket path that exists and is NOT a socket yields `InvalidConfig`
    /// ("refusing to bind ... not a socket" — a policy refusal to clobber the
    /// operator's file), while a genuine metadata read failure on that path
    /// becomes `Io` via `e.into()`. Folding the two together would hide "you
    /// misconfigured the path" behind a generic io error string, and would let
    /// a `?` on any unrelated io::Error silently impersonate that decision.
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Not implemented (EXPERIMENTAL runtime): {0}")]
    NotImplemented(String),

    #[error("Compilation failed: {0}")]
    CompilationFailed(String),

    #[error("Host API error: {0}")]
    HostApi(String),
}

pub type Result<T> = std::result::Result<T, BotRuntimeError>;

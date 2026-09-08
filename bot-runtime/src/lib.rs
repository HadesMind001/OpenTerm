//! OpenTerm bot runtime — **EXPERIMENTAL**.
//!
//! A wasmtime-based host skeleton for sandboxed trading strategies. Today it
//! compiles, its unit tests pass, and that is the entire list of things it
//! does: no guest module can be produced by the loaders, nothing launches
//! this binary, and the Python app's bot registry never talks to it. Read
//! `README.md` next to this crate before contributing or demoing anything.

pub mod cli;
pub mod error;
pub mod host;
pub mod loader;
pub mod manifest;
pub mod runtime;
pub mod transport;

pub use error::{BotRuntimeError, Result};
// NOTE: BotManifest et al. are re-exports of openterm-bot-protocol (see
// manifest.rs) — one source of truth, not two drifting copies.
pub use loader::{get_loader, JavaScriptLoader, LanguageLoader, PythonLoader, RustLoader};
pub use manifest::{
    BotCapabilities, BotConfig, BotLanguage, BotManifest, BotState, BotStats, BotStatus,
};
pub use transport::{connect_client, TransportHandle, TransportServer};

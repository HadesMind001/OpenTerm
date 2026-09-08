//! Compatibility shim — every type here is a re-export of
//! [`openterm_bot_protocol`].
//!
//! This module used to be a byte-for-byte copy of bot-protocol's manifests
//! (plus one extra `Display` impl and a duplicated `check_symbol_allowed`),
//! which meant `openterm_bot_runtime::BotManifest` and
//! `openterm_bot_protocol::BotManifest` were DIFFERENT types with the same
//! name — the exact kind of bug that eats a day per sighting. Delete this
//! file and import from `openterm_bot_protocol` directly once all call
//! sites are migrated.

pub use openterm_bot_protocol::{
    Account, Bar, BotCapabilities, BotConfig, BotEvent, BotInfo, BotLanguage, BotLogEntry,
    BotManifest, BotMetadata, BotRequest, BotResponse, BotState, BotStats, BotStatus, Fill,
    OrderRequest, OrderResponse, Position, Quote, Trade,
};

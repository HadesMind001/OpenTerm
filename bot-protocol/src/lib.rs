//! OpenTerm bot wire protocol — THE single home for every type that crosses
//! the Python-app ⇄ Rust-runtime boundary, or appears in a manifest.
//!
//! HISTORY: these types used to exist in FOUR places (this crate,
//! bot-runtime/src/manifest.rs, bot-runtime/src/host/api.rs, and Python
//! dataclasses in backend/openterm/services/bot_manager.py) with subtly
//! divergent copies — `BotStats` alone had three definitions. The Rust copies
//! are now re-exports of THIS file; the Python ones remain a known debt
//! (documented in bot-runtime/README.md). When you add a type, add it here
//! and nowhere else.
//!
//! STATUS: EXPERIMENTAL. Nothing end-to-end executes a bot yet; the shape of
//! this contract is stable enough to build on, the runtime around it is not.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum BotRequest {
    Deploy {
        bot_id: String,
        wasm_bytes: Vec<u8>,
        manifest: BotManifest,
    },
    Start {
        bot_id: String,
    },
    Stop {
        bot_id: String,
    },
    Restart {
        bot_id: String,
    },
    GetStatus {
        bot_id: String,
    },
    ListBots,
    GetLogs {
        bot_id: String,
        follow: bool,
        lines: usize,
    },
    UpdateConfig {
        bot_id: String,
        config: HashMap<String, serde_json::Value>,
    },
    Ping,
    MarketDataSubscribe {
        symbols: Vec<String>,
        interval: String,
    },
    MarketDataUnsubscribe {
        symbols: Vec<String>,
        interval: String,
    },
    GetBars {
        symbol: String,
        interval: String,
        limit: usize,
    },
    GetQuote {
        symbol: String,
    },
    PlaceOrder {
        #[serde(flatten)]
        request: OrderRequest,
    },
    CancelOrder {
        order_id: String,
    },
    GetAccount,
    GetPosition {
        symbol: String,
    },
    Log {
        level: String,
        message: String,
    },
    TimerCallback {
        callback_id: String,
    },
    EmitSignal {
        name: String,
        payload: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum BotResponse {
    Ok {
        result: serde_json::Value,
    },
    Error {
        code: i32,
        message: String,
    },
    Status(BotStatus),
    Logs(Vec<BotLogEntry>),
    BotList(Vec<BotInfo>),
    Pong,
    Event(BotEvent),
    MarketData {
        bars: Vec<Bar>,
        quote: Option<Quote>,
    },
    OrderPlaced {
        order: OrderResponse,
    },
    OrderCanceled {
        order_id: String,
    },
    Account {
        account: Account,
    },
    Position {
        position: Option<Position>,
    },
    SignalEmitted,
    TimerSet {
        timer_id: u64,
    },
    TimerCanceled,
    PersistenceGet {
        value: Option<String>,
    },
    PersistenceList {
        keys: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotManifest {
    pub bot: BotMetadata,
    pub capabilities: BotCapabilities,
    pub config: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotMetadata {
    pub name: String,
    pub version: String,
    pub language: BotLanguage,
    pub entrypoint: String,
    pub description: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BotLanguage {
    Python,
    JavaScript,
    Rust,
    AssemblyScript,
}

impl std::fmt::Display for BotLanguage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            BotLanguage::Python => "python",
            BotLanguage::JavaScript => "javascript",
            BotLanguage::Rust => "rust",
            BotLanguage::AssemblyScript => "assemblyscript",
        };
        f.write_str(s)
    }
}

/// Everything needed to load one bot from disk. Lives here (not in
/// bot-runtime/manifest.rs like it used to) because the app needs to speak
/// the same shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    pub bot_dir: std::path::PathBuf,
    pub manifest: BotManifest,
    pub wasm_path: std::path::PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotCapabilities {
    pub allowed_symbols: Vec<String>,
    pub denied_symbols: Vec<String>,
    pub max_position_usd: f64,
    pub max_daily_loss_usd: f64,
    pub max_drawdown_pct: f64,
    pub can_place_orders: bool,
    pub can_read_positions: bool,
    pub can_emit_signals: bool,
    pub can_access_market_data: bool,
    pub max_orders_per_minute: u32,
    pub max_memory_mb: u32,
    pub max_fuel_per_callback: u64,
}

impl BotCapabilities {
    /// Denylist wins over allowlist; `*` is the wildcard both sides accept.
    /// (Moved here from the deleted duplicate in bot-runtime/src/manifest.rs —
    /// the two copies had IDENTICAL logic and diverged only in which one
    /// callers could find.)
    pub fn check_symbol_allowed(&self, symbol: &str) -> bool {
        if self.denied_symbols.iter().any(|s| s == symbol || s == "*") {
            return false;
        }
        if self.allowed_symbols.iter().any(|s| s == symbol || s == "*") {
            return true;
        }
        false
    }
}

impl Default for BotCapabilities {
    fn default() -> Self {
        Self {
            allowed_symbols: vec!["*".to_string()],
            denied_symbols: vec![],
            max_position_usd: 10000.0,
            max_daily_loss_usd: 500.0,
            max_drawdown_pct: 0.10,
            can_place_orders: true,
            can_read_positions: true,
            can_emit_signals: true,
            can_access_market_data: true,
            max_orders_per_minute: 60,
            max_memory_mb: 64,
            max_fuel_per_callback: 10_000_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotStatus {
    pub bot_id: String,
    pub state: BotState,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_heartbeat: Option<chrono::DateTime<chrono::Utc>>,
    pub error: Option<String>,
    pub stats: BotStats,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BotState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
    Killed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BotStats {
    pub callbacks_executed: u64,
    pub orders_placed: u64,
    pub orders_filled: u64,
    pub signals_emitted: u64,
    pub fuel_consumed: u64,
    pub peak_memory_mb: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotInfo {
    pub bot_id: String,
    pub name: String,
    pub state: BotState,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotLogEntry {
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum BotEvent {
    BotStarted {
        bot_id: String,
    },
    BotStopped {
        bot_id: String,
    },
    BotError {
        bot_id: String,
        error: String,
    },
    BotKilled {
        bot_id: String,
        reason: String,
    },
    OrderPlaced {
        bot_id: String,
        order_id: String,
        symbol: String,
        side: String,
        qty: f64,
    },
    OrderFilled {
        bot_id: String,
        order_id: String,
        symbol: String,
        price: f64,
        qty: f64,
    },
    SignalEmitted {
        bot_id: String,
        signal: String,
        payload: serde_json::Value,
    },
    LogEntry {
        bot_id: String,
        entry: BotLogEntry,
    },
    ConfigChanged {
        bot_id: String,
    },
    Heartbeat {
        bot_id: String,
        stats: BotStats,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketDataRequest {
    pub symbol: String,
    pub interval: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketDataResponse {
    pub bars: Vec<Bar>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bar {
    pub symbol: String,
    pub interval: String,
    pub ts: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub v: f64,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderRequest {
    pub symbol: String,
    pub side: String,
    pub order_type: String,
    pub qty: f64,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub tif: String,
    pub client_order_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResponse {
    pub order_id: String,
    pub client_order_id: Option<String>,
    pub status: String,
    pub filled_qty: f64,
    pub avg_fill_price: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub symbol: String,
    pub qty: f64,
    pub avg_entry_price: f64,
    pub mark_price: f64,
    pub unrealized_pnl: f64,
    pub realized_pnl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub equity: f64,
    pub cash: f64,
    pub buying_power: f64,
    pub daily_pnl: f64,
    pub positions: Vec<Position>,
}

/// A single print. The ONLY market type that used to exist exclusively in
/// bot-runtime/src/host/api.rs, which forced api.rs to keep its own copy of
/// literally every OTHER type just to reference it. Fixed by moving it home.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub symbol: String,
    pub price: f64,
    pub size: f64,
    pub side: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    pub symbol: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    pub bid_size: Option<f64>,
    pub ask_size: Option<f64>,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub order_id: String,
    pub symbol: String,
    pub side: String,
    pub qty: f64,
    pub price: f64,
    pub fee: f64,
    pub ts: i64,
    pub realized_pnl: f64,
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrips_through_json() {
        let req = BotRequest::Start {
            bot_id: "abc123".into(),
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: BotRequest = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, BotRequest::Start { bot_id } if bot_id == "abc123"));
    }

    #[test]
    fn capabilities_denylist_beats_allowlist() {
        let mut caps = BotCapabilities::default();
        assert!(caps.check_symbol_allowed("BTCUSDT"));
        caps.denied_symbols = vec!["BTCUSDT".into()];
        assert!(!caps.check_symbol_allowed("BTCUSDT"));
        caps.allowed_symbols = vec![];
        caps.denied_symbols = vec![];
        assert!(!caps.check_symbol_allowed("ANY"));
    }

    #[test]
    fn events_tag_by_variant_name() {
        let ev = BotEvent::BotKilled {
            bot_id: "x".into(),
            reason: "drawdown".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["event"], "BotKilled");
        assert_eq!(v["data"]["reason"], "drawdown");
    }
}

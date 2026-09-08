//! Host-side capability traits — the seam where a real broker/market-data
//! implementation would plug in.
//!
//! The type definitions this file used to carry (Bar, Quote, OrderRequest,
//! OrderResponse, Position, Account, Fill, and even a local BotEvent
//! clone) were copies of bot-protocol with one original (`Trade`). The
//! copies are gone; only the trait definitions remain, typed against the
//! protocol. A previous generation of this file also held six `Mock*` impls
//! plus an un-instantiated `HostApi<M,O,A,L,T,S,P>` generic struct that no
//! test or production code ever touched — dead weight deleted rather than
//! decorated.

use async_trait::async_trait;

pub use openterm_bot_protocol::{
    Account, Bar, BotEvent, BotRequest, BotResponse, Fill, OrderRequest, OrderResponse, Position,
    Quote, Trade,
};

#[async_trait]
pub trait MarketDataProvider: Send + Sync {
    async fn subscribe_bars(
        &self,
        symbols: Vec<String>,
        interval: String,
    ) -> crate::error::Result<()>;
    async fn unsubscribe_bars(
        &self,
        symbols: Vec<String>,
        interval: String,
    ) -> crate::error::Result<()>;
    async fn get_bars(
        &self,
        symbol: &str,
        interval: &str,
        limit: usize,
    ) -> crate::error::Result<Vec<Bar>>;
    async fn get_quote(&self, symbol: &str) -> crate::error::Result<Option<Quote>>;
    async fn get_recent_trades(
        &self,
        symbol: &str,
        limit: usize,
    ) -> crate::error::Result<Vec<Trade>>;
}

#[async_trait]
pub trait OrderRouter: Send + Sync {
    /// Place an order. Implementations MUST NOT return a fabricated
    /// success: the deleted `MockOrderRouter` invented uuid order ids for
    /// wasm guest calls and made a non-executing runtime LOOK like it was
    /// trading. No router wired => host function returns an error code.
    async fn place_order(&self, req: OrderRequest) -> crate::error::Result<OrderResponse>;
    async fn cancel_order(&self, order_id: &str) -> crate::error::Result<()>;
    async fn get_order(&self, order_id: &str) -> crate::error::Result<Option<OrderResponse>>;
    async fn get_working_orders(
        &self,
        symbol: Option<&str>,
    ) -> crate::error::Result<Vec<OrderResponse>>;
}

#[async_trait]
pub trait AccountProvider: Send + Sync {
    async fn get_account(&self) -> crate::error::Result<Account>;
    async fn get_position(&self, symbol: &str) -> crate::error::Result<Option<Position>>;
    async fn get_all_positions(&self) -> crate::error::Result<Vec<Position>>;
}

#[async_trait]
pub trait BotLogger: Send + Sync {
    async fn log(&self, level: &str, message: &str);
}

#[async_trait]
pub trait TimerService: Send + Sync {
    async fn set_timer(&self, interval_ms: u64, callback_id: String) -> crate::error::Result<u64>;
    async fn cancel_timer(&self, timer_id: u64) -> crate::error::Result<()>;
}

#[async_trait]
pub trait SignalEmitter: Send + Sync {
    async fn emit_signal(&self, name: &str, payload: serde_json::Value)
        -> crate::error::Result<()>;
}

#[async_trait]
pub trait PersistenceProvider: Send + Sync {
    async fn get(&self, key: &str) -> crate::error::Result<Option<String>>;
    async fn set(&self, key: &str, value: &str) -> crate::error::Result<()>;
    async fn delete(&self, key: &str) -> crate::error::Result<()>;
    async fn list_keys(&self, prefix: &str) -> crate::error::Result<Vec<String>>;
}

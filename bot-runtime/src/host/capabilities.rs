//! The single source of truth for runtime guardrail STATE: the per-minute
//! order-rate window, the daily-PnL / peak-equity / kill-switch numbers, and
//! the capability checks that read them.
//!
//! WHY THIS FILE AND NOT `runtime/guardrails.rs`: `RiskGuard` used to keep its
//! OWN copies of daily_pnl / peak_equity / killed / kill_reason while
//! CapabilityManager kept live copies of the same four numbers, and they
//! drifted — `is_killed()` consulted one store while `check_order_permission()`
//! consulted the other, so a tripped kill switch did not actually stop orders.
//! The duplicate state was deleted (see the guardrails.rs module doc); these
//! numbers live here EXACTLY ONCE and RiskGuard is now pure logic over this
//! type. Do not add a second home for any of it.
//!
//! WHY `parking_lot::RwLock` per field (not one `Mutex`): most of this is READ
//! on the order hot path — every `check_order_permission` reads `killed`, every
//! `check_daily_loss` reads `daily_pnl` — but it only MUTATES on discrete
//! events (a fill, a tripped limit, a daily reset). An RwLock lets many
//! in-flight orders read the kill switch concurrently while a state change
//! still gets exclusive access; parking_lot's `read()`/`write()` also never
//! return `Result` (no poisoning), which is why the call sites look so bare.
//! Caveat, stated not hidden: `check_rate_limit` write-locks `order_count` /
//! `window_start` because rolling the window mutates them, so the RwLock buys
//! nothing for those two fields specifically — it is the right choice for the
//! read-mostly kill/pnl state and merely adequate for the counter.

use crate::error::Result;
use crate::manifest::BotCapabilities;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

/// Guardrail state for one bot. Three field groups, three cadences:
///   * `order_count` / `window_start` — the per-minute rate window (§ `check_rate_limit`).
///   * `daily_pnl` / `peak_equity` — drawdown/loss tracking, updated on fills.
///   * `killed` / `kill_reason` — the latch; once true it stays true until
///     `reset_daily`, and every order path consults it before doing anything.
pub struct CapabilityManager {
    pub capabilities: BotCapabilities,
    order_count: RwLock<HashMap<String, u32>>,
    window_start: RwLock<Instant>,
    daily_pnl: RwLock<f64>,
    peak_equity: RwLock<f64>,
    killed: RwLock<bool>,
    kill_reason: RwLock<Option<String>>,
}

impl CapabilityManager {
    pub fn new(capabilities: BotCapabilities) -> Self {
        Self {
            capabilities,
            order_count: RwLock::new(HashMap::new()),
            window_start: RwLock::new(Instant::now()),
            daily_pnl: RwLock::new(0.0),
            peak_equity: RwLock::new(0.0),
            killed: RwLock::new(false),
            kill_reason: RwLock::new(None),
        }
    }

    pub fn check_symbol(&self, symbol: &str) -> Result<()> {
        if !self.capabilities.check_symbol_allowed(symbol) {
            return Err(crate::error::BotRuntimeError::CapabilityDenied(format!(
                "Symbol {} not allowed",
                symbol
            )));
        }
        Ok(())
    }

    pub fn check_order_permission(&self) -> Result<()> {
        if !self.capabilities.can_place_orders {
            return Err(crate::error::BotRuntimeError::CapabilityDenied(
                "Order placement not allowed".to_string(),
            ));
        }
        if *self.killed.read() {
            return Err(crate::error::BotRuntimeError::KillSwitch(
                self.kill_reason.read().clone().unwrap_or_default(),
            ));
        }
        self.check_rate_limit()
    }

    /// Enforce the per-minute order budget.
    ///
    /// The budget is checked against the SUM of orders across ALL symbols,
    /// deliberately: `max_orders_per_minute` is an absolute cap for the whole
    /// bot, not a per-symbol one. If each symbol had its own window, a bot
    /// trading N symbols could legally fire `max_orders_per_minute` on every
    /// one of them — N x M orders/minute — and the limit would be a fiction.
    /// The cross-symbol total is the conservative reading, so booking a "BTC"
    /// order genuinely eats into the budget a later "ETH" order sees (see the
    /// note on `record_order`). The window rolls on the wall: >=60s since
    /// `window_start` clears every bucket at once.
    ///
    /// Takes WRITE locks even though it reads like a check: rolling the window
    /// mutates the map, so there is no read-only version of this path.
    fn check_rate_limit(&self) -> Result<()> {
        let mut counts = self.order_count.write();
        let mut window = self.window_start.write();
        let now = Instant::now();

        if now.duration_since(*window).as_secs() >= 60 {
            counts.clear();
            *window = now;
        }

        let total: u32 = counts.values().sum();
        if total >= self.capabilities.max_orders_per_minute {
            return Err(crate::error::BotRuntimeError::ResourceLimitExceeded(
                "Order rate limit exceeded".to_string(),
            ));
        }
        Ok(())
    }

    /// NOTE: the rate window counts ALL symbols together (`total`, summed
    /// across every symbol in `check_rate_limit` just above).
    /// The per-symbol buckets exist only so a future `max_orders_per_minute`
    /// per symbol can be added — today `record_order("BTC")` starves
    /// `check_rate_limit()` for "ETH". Documented, not silently wrong.
    pub fn record_order(&self, symbol: &str) {
        let mut counts = self.order_count.write();
        *counts.entry(symbol.to_string()).or_insert(0) += 1;
    }

    /// Single-order notional check. `symbol` is unused on purpose: true
    /// per-symbol AGGREGATE exposure requires the live position book, which
    /// lives in RiskGuard and is not fed back here until fills are wired.
    pub fn check_position_limit(&self, _symbol: &str, qty: f64, price: f64) -> Result<()> {
        let notional = qty.abs() * price;
        if notional > self.capabilities.max_position_usd {
            return Err(crate::error::BotRuntimeError::ResourceLimitExceeded(
                format!(
                    "Position notional ${:.2} exceeds limit ${:.2}",
                    notional, self.capabilities.max_position_usd
                ),
            ));
        }
        Ok(())
    }

    pub fn check_daily_loss(&self) -> Result<()> {
        let daily = *self.daily_pnl.read();
        if daily <= -self.capabilities.max_daily_loss_usd {
            self.trigger_kill_switch(format!("Daily loss limit exceeded: ${:.2}", daily));
            return Err(crate::error::BotRuntimeError::KillSwitch(
                "Daily loss limit exceeded".to_string(),
            ));
        }
        Ok(())
    }

    pub fn update_daily_pnl(&self, pnl: f64, equity: f64) -> Result<()> {
        let mut daily = self.daily_pnl.write();
        *daily += pnl;

        let mut peak = self.peak_equity.write();
        if equity > *peak {
            *peak = equity;
        }

        let drawdown = if *peak > 0.0 {
            (*peak - equity) / *peak
        } else {
            0.0
        };

        if *daily <= -self.capabilities.max_daily_loss_usd {
            self.trigger_kill_switch(format!("Daily loss limit exceeded: ${:.2}", *daily));
            return Err(crate::error::BotRuntimeError::KillSwitch(
                "Daily loss limit exceeded".to_string(),
            ));
        }

        if drawdown >= self.capabilities.max_drawdown_pct {
            self.trigger_kill_switch(format!("Max drawdown exceeded: {:.2}%", drawdown * 100.0));
            return Err(crate::error::BotRuntimeError::KillSwitch(
                "Max drawdown exceeded".to_string(),
            ));
        }

        Ok(())
    }

    pub fn check_emit_signals(&self) -> Result<()> {
        if !self.capabilities.can_emit_signals {
            return Err(crate::error::BotRuntimeError::CapabilityDenied(
                "Signal emission not allowed".to_string(),
            ));
        }
        Ok(())
    }

    pub fn trigger_kill_switch(&self, reason: String) {
        *self.killed.write() = true;
        *self.kill_reason.write() = Some(reason);
    }

    pub fn is_killed(&self) -> bool {
        *self.killed.read()
    }

    pub fn kill_reason(&self) -> Option<String> {
        self.kill_reason.read().clone()
    }

    pub fn get_daily_pnl(&self) -> f64 {
        *self.daily_pnl.read()
    }

    pub fn get_peak_equity(&self) -> f64 {
        *self.peak_equity.read()
    }

    pub fn reset_daily(&self) {
        *self.daily_pnl.write() = 0.0;
        *self.peak_equity.write() = 0.0;
        *self.killed.write() = false;
        *self.kill_reason.write() = None;
    }
}

impl Default for CapabilityManager {
    fn default() -> Self {
        Self::new(BotCapabilities::default())
    }
}

pub type SharedCapabilityManager = Arc<CapabilityManager>;
#[cfg(test)]
mod tests {
    use super::*;

    fn mgr() -> CapabilityManager {
        CapabilityManager::new(BotCapabilities {
            max_daily_loss_usd: 100.0,
            max_drawdown_pct: 0.10,
            max_position_usd: 1000.0,
            max_orders_per_minute: 2,
            ..Default::default()
        })
    }

    #[test]
    fn denied_symbol_stays_denied() {
        let m = CapabilityManager::new(BotCapabilities {
            denied_symbols: vec!["DOGEUSDT".into()],
            ..Default::default()
        });
        assert!(m.check_symbol("DOGEUSDT").is_err());
        assert!(m.check_symbol("BTCUSDT").is_ok());
    }

    #[test]
    fn rate_limit_caps_the_minute_window() {
        let m = mgr();
        assert!(m.check_order_permission().is_ok());
        m.record_order("BTCUSDT");
        m.record_order("ETHUSDT");
        // two orders booked; the limit is two — third must be refused
        assert!(m.check_order_permission().is_err());
    }

    #[test]
    fn daily_loss_triggers_and_remembers_kill() {
        let m = mgr();
        let err = m.update_daily_pnl(-150.0, 5000.0).unwrap_err();
        assert!(matches!(err, crate::error::BotRuntimeError::KillSwitch(_)));
        assert!(m.is_killed());
        assert!(m.kill_reason().unwrap().contains("Daily loss"));
        // killed state blocks all further order permission, too
        assert!(m.check_order_permission().is_err());
    }

    #[test]
    fn drawdown_triggers_kill() {
        let m = mgr();
        m.update_daily_pnl(0.0, 10000.0).unwrap(); // establish peak
        assert!(m.update_daily_pnl(0.0, 8000.0).is_err()); // -20% drawdown
        assert!(m.is_killed());
    }
}

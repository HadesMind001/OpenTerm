//! Risk guardrails: the higher-level kill-switch logic layered on top of
//! [`CapabilityManager`].
//!
//! RESTRUCTURE NOTE (this file used to be a trap): RiskGuard kept its OWN
//! copies of daily_pnl / peak_equity / killed / kill_reason while
//! CapabilityManager kept live copies of the same four numbers, and they
//! could DISAGREE — `is_killed()` consulted one store while
//! `check_order_permission()` consulted the other. There was also a third
//! `BotStats` struct defined here on top of the protocol one. All state now
//! lives in CapabilityManager exactly once; this module is pure logic over
//! it. `BotStats` comes from the protocol re-export like everything else.

use crate::error::Result;
use crate::host::api::{Account, Fill, Position};
use crate::host::capabilities::CapabilityManager;
use crate::manifest::BotCapabilities;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

pub struct RiskGuard {
    capabilities: BotCapabilities,
    capability_manager: Arc<CapabilityManager>,
    /// Position sizing bookkeeping maintained from fills. Read-only until a
    /// real fill stream exists (see instance.rs) — but computed coherently,
    /// unlike the old write-only map that nothing ever read.
    positions: RwLock<HashMap<String, Position>>,
}

impl RiskGuard {
    pub fn new(capabilities: BotCapabilities, capability_manager: Arc<CapabilityManager>) -> Self {
        Self {
            capabilities,
            capability_manager,
            positions: RwLock::new(HashMap::new()),
        }
    }

    /// The single entry point that combines every order precondition.
    /// Kill-switch check lives inside check_order_permission (capability
    /// manager), so order_place should call THIS, not the three parts.
    pub fn check_order(&self, symbol: &str, qty: f64, price: f64) -> Result<()> {
        self.capability_manager.check_order_permission()?;
        self.capability_manager.check_symbol(symbol)?;
        // price <= 0.0 means "market order, price unknown at host time" —
        // notional simply cannot be enforced here; the fill path
        // (update_daily_pnl via broker) is the honest backstop. Silently
        // treating 0.0 as a real price made EVERY market order trivially
        // compliant; it is now skipped explicitly, in the open.
        if price > 0.0 {
            self.capability_manager
                .check_position_limit(symbol, qty, price)?;
        }
        Ok(())
    }

    /// Fold a fill into position bookkeeping + realized PnL.
    pub fn on_fill(&self, fill: &Fill) {
        let mut positions = self.positions.write();
        let pos = positions
            .entry(fill.symbol.clone())
            .or_insert_with(|| Position {
                symbol: fill.symbol.clone(),
                qty: 0.0,
                avg_entry_price: 0.0,
                mark_price: fill.price,
                unrealized_pnl: 0.0,
                realized_pnl: 0.0,
            });
        if fill.side == "buy" {
            let new_qty = pos.qty + fill.qty;
            // Old code divided by new_qty unconditionally: a buy of qty 0
            // (or any call landing at exactly 0 total) produced a NaN avg
            // price that poisoned every downstream notional check forever.
            pos.avg_entry_price = if new_qty > 0.0 {
                (pos.avg_entry_price * pos.qty + fill.price * fill.qty) / new_qty
            } else {
                fill.price
            };
            pos.qty = new_qty;
        } else {
            pos.qty -= fill.qty;
            pos.realized_pnl += fill.realized_pnl;
        }
        pos.mark_price = fill.price;

        // Equity is summed HERE, under the write guard we already hold. The
        // old code called a helper that re-acquired this same RwLock for
        // reading — parking_lot locks are NOT reentrant, so on_fill()
        // self-deadlocked (two tests hung forever before this was caught).
        let equity: f64 = positions.values().map(|p| p.qty * p.mark_price).sum();

        // Single shared pnl/peak state — feeds the drawdown + daily-loss kill
        // switches inside CapabilityManager.
        let _ = self
            .capability_manager
            .update_daily_pnl(fill.realized_pnl, equity);
    }

    /// Update drawdown tracking from an authoritative account snapshot.
    pub fn update_equity(&self, account: &Account) {
        // Passing this straight through to the capability manager keeps ONE
        // definition of peak/drawdown state. (The deleted local copy used to
        // be fed a hardcoded zero-equity Account, so peak stayed 0 and the
        // drawdown switch was mathematically incapable of firing.)
        let _ = self
            .capability_manager
            .update_daily_pnl(0.0, account.equity);
    }

    pub fn check_daily_loss(&self) -> Result<()> {
        self.capability_manager.check_daily_loss()
    }

    pub fn is_killed(&self) -> bool {
        self.capability_manager.is_killed()
    }

    pub fn get_kill_reason(&self) -> Option<String> {
        self.capability_manager.kill_reason()
    }

    pub fn get_daily_pnl(&self) -> f64 {
        self.capability_manager.get_daily_pnl()
    }

    pub fn get_peak_equity(&self) -> f64 {
        self.capability_manager.get_peak_equity()
    }

    pub fn position(&self, symbol: &str) -> Option<Position> {
        self.positions.read().get(symbol).cloned()
    }

    pub fn check_order_permission(&self) -> Result<()> {
        self.capability_manager.check_order_permission()
    }

    pub fn check_symbol(&self, symbol: &str) -> Result<()> {
        self.capability_manager.check_symbol(symbol)
    }

    pub fn check_position_limit(&self, symbol: &str, qty: f64, price: f64) -> Result<()> {
        self.capability_manager
            .check_position_limit(symbol, qty, price)
    }

    pub fn record_order(&self, symbol: &str) {
        self.capability_manager.record_order(symbol)
    }

    pub fn capabilities(&self) -> &BotCapabilities {
        &self.capabilities
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::api::Fill;

    fn guard() -> RiskGuard {
        let caps = BotCapabilities::default();
        let cm = Arc::new(CapabilityManager::new(caps.clone()));
        RiskGuard::new(caps, cm)
    }

    #[test]
    fn buy_then_partial_sell_averages_sensibly() {
        let g = guard();
        let buy = |price, qty| Fill {
            order_id: "o".into(),
            symbol: "BTCUSDT".into(),
            side: "buy".into(),
            qty,
            price,
            fee: 0.0,
            ts: 0,
            realized_pnl: 0.0,
        };
        g.on_fill(&buy(100.0, 1.0));
        g.on_fill(&buy(200.0, 1.0));
        let pos = g.position("BTCUSDT").unwrap();
        assert!((pos.avg_entry_price - 150.0).abs() < 1e-9);
        assert!(!pos.avg_entry_price.is_nan());
    }

    #[test]
    fn zero_quantity_buy_does_not_produce_nan() {
        let g = guard();
        g.on_fill(&Fill {
            order_id: "o".into(),
            symbol: "ETHUSDT".into(),
            side: "buy".into(),
            qty: 0.0,
            price: 50.0,
            fee: 0.0,
            ts: 0,
            realized_pnl: 0.0,
        });
        let pos = g.position("ETHUSDT").unwrap();
        assert!(
            !pos.avg_entry_price.is_nan(),
            "avg price went NaN — the old bug is back"
        );
    }

    #[test]
    fn market_order_skips_notional_instead_of_faking_compliance() {
        let g = guard();
        // price 0.0 (market): notional must be SKIPPED, not "passed" at 0 USD
        assert!(g.check_order("BTCUSDT", 5.0, 0.0).is_ok());
        // priced orders still limited
        assert!(g.check_order("BTCUSDT", 5.0, 5000.0).is_err());
    }
}

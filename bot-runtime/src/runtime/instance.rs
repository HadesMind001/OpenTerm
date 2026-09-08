//! Host wiring for one wasmtime bot instance — **EXPERIMENTAL SKELETON**.
//!
//! ABI: guests import functions from the `"env"` module and export
//! `memory` plus lifecycle functions (`on_start`, `on_bar`, `on_quote`,
//! `on_trade`, `on_fill`, `on_timer`, `on_signal`).
//!
//! HISTORY THAT WILL GET YOU BURNED IF YOU IGNORE IT:
//!   * This file used to coexist with a SECOND, parallel host-function table
//!     under module `"host"` (runtime/callbacks.rs) defining the same
//!     functions with different signatures. Two ABIs, one guest, zero
//!     chance of agreement — callbacks.rs is deleted; `"env"` is the ABI.
//!     Any guest you ever write must import from `"env"`. Nothing validates
//!     that yet.
//!   * `order_place` used to return success with a fabricated uuid order id
//!     (via a MockOrderRouter that touched no broker). A trading system
//!     inventing fills is the worst possible class of bug; it now returns an
//!     explicit unsupported code until an OrderRouter is wired for real.
//!   * String reads from guest memory are guest-controlled (ptr, len as
//!     i32). The old code computed `start + len as usize` and bounds-checked
//!     AFTER the addition — a hostile or buggy guest with negative ptr/len
//!     hit arithmetic overflow panic on debug builds. Checked arithmetic now.

use crate::error::{BotRuntimeError, Result};
use crate::host::api::{Bar, Fill, PersistenceProvider, Quote, Trade};
use crate::host::capabilities::CapabilityManager;
use crate::host::fuel::{add_fuel_to_store, create_engine};
use crate::host::limits::ResourceLimiter;
use crate::host::persistence::SqlitePersistence;
use crate::manifest::{BotCapabilities, BotConfig};
use crate::runtime::guardrails::RiskGuard;
use parking_lot::RwLock;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::warn;
use wasmtime::*;

/// Instance-internal event stream.
///
/// Renamed from `BotEvent`: a second type with that name (the PROTOCOL
/// event, used by the transport) lived in the same crate, and half the code
/// needed one while half needed the other. Same-name-different-type bugs
/// compile; they just fail weird. Wire translations happen at the transport
/// boundary, not here.
#[derive(Debug, Clone)]
pub enum RuntimeEvent {
    Bar(Bar),
    Quote(Quote),
    Trade(Trade),
    Fill(Fill),
    Signal(String, serde_json::Value),
    Log(String, String),
    KillSwitch(String),
    Heartbeat(crate::manifest::BotStats),
}

/// Host function return codes (i32 ABI).
pub mod rc {
    pub const OK: i32 = 0;
    /// Guest call context had no exported `memory`.
    pub const NO_MEMORY: i32 = -1;
    /// Capability/risk check refused the call.
    pub const DENIED: i32 = -2;
    /// The backing service (order router, market feed, timers) is not wired.
    pub const UNSUPPORTED: i32 = -3;
    /// Needs async and there was no tokio reactor on this thread.
    pub const NO_RUNTIME: i32 = -4;
}

pub struct BotInstance {
    pub config: BotConfig,
    pub engine: Engine,
    pub module: Module,
    pub instance: RwLock<Option<Instance>>,
    pub capabilities: Arc<CapabilityManager>,
    pub risk_guard: Arc<RiskGuard>,
    pub limiter: Arc<ResourceLimiter>,
    pub persistence: Arc<SqlitePersistence>,
    pub callbacks: RwLock<BotCallbacks>,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    // The old code created this channel, DROPPED the receiver in `new()`
    // (`let (tx, _rx)`), and every event — logs, signals, "orders placed" —
    // evaporated on send with callers believing they worked. The receiver is
    // kept reachable via take_event_rx(); until someone drains it the send
    // still succeeds (unbounded), but now the omission is a visible field,
    // not an invisible underscore.
    event_rx: std::sync::Mutex<Option<mpsc::UnboundedReceiver<RuntimeEvent>>>,
}

impl BotInstance {
    pub async fn new(config: BotConfig, capabilities: BotCapabilities) -> Result<Self> {
        let engine = create_engine()?;
        let module = Module::from_file(&engine, &config.wasm_path)?;

        let persistence =
            Arc::new(SqlitePersistence::new(&config.bot_dir.join("state.sqlite")).await?);
        let cap_mgr = Arc::new(CapabilityManager::new(capabilities.clone()));
        let risk_guard = Arc::new(RiskGuard::new(capabilities.clone(), cap_mgr.clone()));
        let limiter = Arc::new(ResourceLimiter::new(capabilities));

        let (tx, rx) = mpsc::unbounded_channel();

        Ok(Self {
            config,
            engine,
            module,
            instance: RwLock::new(None),
            capabilities: cap_mgr,
            risk_guard,
            limiter,
            persistence,
            callbacks: RwLock::new(BotCallbacks::default()),
            event_tx: tx,
            event_rx: std::sync::Mutex::new(Some(rx)),
        })
    }

    /// Drain handle for the event stream. Call EXACTLY ONCE at wiring time;
    /// subsequent calls return None. Without a consumer, RuntimeEvents
    /// accumulate in the unbounded queue — a slow guest is a slow memory
    /// leak, so whoever wires the runtime MUST spawn the pump task.
    pub fn take_event_rx(&self) -> Option<mpsc::UnboundedReceiver<RuntimeEvent>> {
        self.event_rx.lock().ok().and_then(|mut g| g.take())
    }

    pub fn instantiate(&self, mut store: Store<()>) -> Result<Instance> {
        let linker = self.build_linker(&mut store)?;
        let instance = linker.instantiate(&mut store, &self.module)?;
        *self.instance.write() = Some(instance);
        Ok(instance)
    }

    fn build_linker(&self, store: &mut Store<()>) -> Result<Linker<()>> {
        let mut linker = Linker::new(&self.engine);

        // If the guest IMPORTS env.memory (some toolchains do), satisfy the
        // import from the imported type so limits match.
        //
        // The old code scanned `module.exports()` and defined an import out
        // of an export's type — the wrong direction on both ends; any real
        // module importing env.memory would still have failed to instantiate
        // while a module that merely exports memory got a phantom import
        // defined. Both cases are handled distinctly below.
        let memory_import = self
            .module
            .imports()
            .find(|i| i.module() == "env" && i.name() == "memory")
            .and_then(|i| match i.ty() {
                ExternType::Memory(mt) => Some(mt.clone()),
                _ => None,
            });
        if let Some(mt) = memory_import {
            let memory = Memory::new(&mut *store, mt)?;
            linker.define(&*store, "env", "memory", memory)?;
        }

        let caps = self.capabilities.clone();
        let risk = self.risk_guard.clone();
        let events = self.event_tx.clone();
        let persistence = self.persistence.clone();

        // ── market data ────────────────────────────────────────────────
        linker.func_wrap("env", "market_data_subscribe", {
            let caps = caps.clone();
            move |mut caller: Caller<'_, ()>,
                  symbols_ptr: i32,
                  symbols_len: i32,
                  _interval_ptr: i32,
                  _interval_len: i32|
                  -> i32 {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return rc::NO_MEMORY,
                };
                let symbol = mem_str(&memory, &caller, symbols_ptr, symbols_len);
                if caps.check_symbol(&symbol).is_err() {
                    return rc::DENIED;
                }
                // No MarketDataProvider is wired into the instance yet —
                // subscribing succeeds (it's capability-clean) but feeds
                // nothing. UNSUPPORTED keeps guests honest about it.
                rc::UNSUPPORTED
            }
        })?;

        linker.func_wrap(
            "env",
            "market_data_unsubscribe",
            |_c: Caller<'_, ()>, _p: i32, _l: i32, _ip: i32, _il: i32| -> i32 { rc::UNSUPPORTED },
        )?;

        linker.func_wrap(
            "env",
            "market_data_get_bars",
            |_c: Caller<'_, ()>, _p: i32, _l: i32, _ip: i32, _il: i32, _limit: i32| -> i32 {
                rc::UNSUPPORTED
            },
        )?;

        // ── orders ─────────────────────────────────────────────────────
        linker.func_wrap("env", "order_place", {
            let risk = risk.clone();
            let events = events.clone();
            move |mut caller: Caller<'_, ()>,
                  symbol_ptr: i32,
                  symbol_len: i32,
                  _side_ptr: i32,
                  _side_len: i32,
                  _otype_ptr: i32,
                  _otype_len: i32,
                  qty: f64,
                  limit_price: f64,
                  _stop_price: f64,
                  _tif_ptr: i32,
                  _tif_len: i32,
                  _coid_ptr: i32,
                  _coid_len: i32|
                  -> i32 {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return rc::NO_MEMORY,
                };
                let symbol = mem_str(&memory, &caller, symbol_ptr, symbol_len);
                // Full precondition stack (kill switch, symbol allowlist,
                // notional) in ONE call — the old code hand-assembled
                // three checks in three places with divergent state.
                if risk.check_order(&symbol, qty, limit_price).is_err() {
                    return rc::DENIED;
                }
                // An order was NOT placed: no OrderRouter exists. The
                // deleted MockOrderRouter returned a uuid with
                // status="working" and published OrderPlaced onto a
                // channel nobody read — i.e. the runtime LIED that a
                // trade happened. Refusing is the only honest answer.
                warn!("order_place called but no OrderRouter is wired (EXPERIMENTAL)");
                let _ = events.send(RuntimeEvent::Log(
                    "warn".into(),
                    format!("order refused (no router): {symbol} qty={qty}"),
                ));
                rc::UNSUPPORTED
            }
        })?;

        linker.func_wrap(
            "env",
            "order_cancel",
            |_c: Caller<'_, ()>, _p: i32, _l: i32| -> i32 { rc::UNSUPPORTED },
        )?;

        // ── account ────────────────────────────────────────────────────
        linker.func_wrap("env", "account_get", |_c: Caller<'_, ()>| -> i32 {
            rc::UNSUPPORTED
        })?;
        linker.func_wrap(
            "env",
            "position_get",
            |_c: Caller<'_, ()>, _p: i32, _l: i32| -> i32 { rc::UNSUPPORTED },
        )?;

        // ── logging (the ONE genuinely working host function) ──────────
        linker.func_wrap("env", "log", {
            let events = events.clone();
            move |mut caller: Caller<'_, ()>,
                  level_ptr: i32,
                  level_len: i32,
                  message_ptr: i32,
                  message_len: i32|
                  -> i32 {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return rc::NO_MEMORY,
                };
                let level = mem_str(&memory, &caller, level_ptr, level_len);
                let message = mem_str(&memory, &caller, message_ptr, message_len);
                let _ = events.send(RuntimeEvent::Log(level.clone(), message.clone()));
                match level.as_str() {
                    "error" => tracing::error!(target: "bot", "{message}"),
                    "warn" => tracing::warn!(target: "bot", "{message}"),
                    _ => tracing::info!(target: "bot", "{message}"),
                }
                rc::OK
            }
        })?;

        // ── timers (not wired; return 0 == "timer id" would be a lie) ──
        linker.func_wrap(
            "env",
            "timer_set",
            |_c: Caller<'_, ()>, _ms: u64, _p: i32, _l: i32| -> u64 {
                0 // 0 documented as "no timer service"; ids start at 1
            },
        )?;
        linker.func_wrap(
            "env",
            "timer_cancel",
            |_c: Caller<'_, ()>, _id: u64| -> i32 { rc::UNSUPPORTED },
        )?;

        // ── signals ────────────────────────────────────────────────────
        linker.func_wrap("env", "signal_emit", {
            let caps = caps.clone();
            let events = events.clone();
            move |mut caller: Caller<'_, ()>,
                  name_ptr: i32,
                  name_len: i32,
                  payload_ptr: i32,
                  payload_len: i32|
                  -> i32 {
                if caps.check_emit_signals().is_err() {
                    return rc::DENIED;
                }
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return rc::NO_MEMORY,
                };
                let name = mem_str(&memory, &caller, name_ptr, name_len);
                let payload = mem_str(&memory, &caller, payload_ptr, payload_len);
                let parsed = serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
                let _ = events.send(RuntimeEvent::Signal(name, parsed));
                rc::OK
            }
        })?;

        // ── persistence ────────────────────────────────────────────────
        // These host functions are SYNCHRONOUS (func_wrap) but
        // SqlitePersistence is async sqlx. The old code called tokio::spawn
        // blindly inside the closure: a guaranteed "no reactor running"
        // panic if the wasm call ever happened off a tokio worker, plus a
        // swallowed error so writes silently vanished. We now check for a
        // runtime and refuse loudly instead of panicking quietly.
        linker.func_wrap(
            "env",
            "persistence_get",
            |_c: Caller<'_, ()>, _p: i32, _l: i32| -> i32 { rc::UNSUPPORTED },
        )?;

        linker.func_wrap("env", "persistence_set", {
            let persistence = persistence.clone();
            move |mut caller: Caller<'_, ()>,
                  key_ptr: i32,
                  key_len: i32,
                  value_ptr: i32,
                  value_len: i32|
                  -> i32 {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return rc::NO_MEMORY,
                };
                let handle = match tokio::runtime::Handle::try_current() {
                    Ok(h) => h,
                    Err(_) => return rc::NO_RUNTIME,
                };
                let key = mem_str(&memory, &caller, key_ptr, key_len);
                let value = mem_str(&memory, &caller, value_ptr, value_len);
                let p = persistence.clone();
                handle.spawn(async move {
                    if let Err(e) = p.set(&key, &value).await {
                        // Fire-and-forget remains (sync ABI), but the
                        // failure is LOGGED, unlike the old `let _ =`.
                        warn!("persistence_set failed for {key}: {e}");
                    }
                });
                rc::OK
            }
        })?;

        Ok(linker)
    }

    pub async fn call_on_start(&self, store: &mut Store<()>) -> Result<()> {
        if let Some(cb) = self.callbacks.read().on_start {
            cb.call(store, &[], &mut [])?;
        }
        Ok(())
    }

    pub async fn call_on_bar(&self, store: &mut Store<()>, _bar: &Bar) -> Result<()> {
        // NOTE: no risk update happens here. The old code called
        // update_equity with a hardcoded `equity: 0.0` Account every bar,
        // which pinned peak_equity at 0 and made the drawdown kill-switch
        // MATHEMATICALLY UNABLE to fire — a guard rail made of fog. Real
        // equity flows in via an AccountProvider once one exists; until
        // then, fill-driven risk (RiskGuard::on_fill) is what's honest.
        if let Some(cb) = self.callbacks.read().on_bar {
            cb.call(store, &[], &mut [])?;
        }
        Ok(())
    }

    pub async fn call_on_fill(&self, store: &mut Store<()>, fill: &Fill) -> Result<()> {
        self.risk_guard.on_fill(fill);
        if let Some(cb) = self.callbacks.read().on_fill {
            cb.call(store, &[], &mut [])?;
        }
        self.risk_guard.check_daily_loss()?;
        Ok(())
    }

    pub async fn call_on_trade(&self, store: &mut Store<()>, _trade: &Trade) -> Result<()> {
        if let Some(cb) = self.callbacks.read().on_trade {
            cb.call(store, &[], &mut [])?;
        }
        Ok(())
    }

    pub fn add_fuel(&self, store: &mut Store<()>, amount: u64) -> Result<()> {
        add_fuel_to_store(store, amount)
    }

    pub fn is_killed(&self) -> bool {
        // Both stores were reconciled when RiskGuard's duplicate state was
        // deleted — this and check_order_permission now consult the SAME
        // kill switch (the capability manager). They used to disagree.
        self.risk_guard.is_killed()
    }

    pub fn deny_reason(err: BotRuntimeError) -> i32 {
        match err {
            BotRuntimeError::KillSwitch(_) | BotRuntimeError::CapabilityDenied(_) => rc::DENIED,
            _ => rc::UNSUPPORTED,
        }
    }
}

#[derive(Default)]
pub struct BotCallbacks {
    pub on_start: Option<Func>,
    pub on_bar: Option<Func>,
    pub on_quote: Option<Func>,
    pub on_trade: Option<Func>,
    pub on_fill: Option<Func>,
    pub on_timer: Option<Func>,
    pub on_signal: Option<Func>,
}

/// Read `len` bytes at `ptr` from guest memory as UTF-8 (lossy).
///
/// Overflow-safe by construction: guest-controlled i32 pairs can be negative
/// or huge; every arithmetic step is checked BEFORE the slice. Returns "" on
/// any suspicion — the caller maps "" to a capability-denied/unsupported rc.
fn mem_str(memory: &Memory, ctx: &impl AsContext, ptr: i32, len: i32) -> String {
    if ptr < 0 || len < 0 {
        return String::new();
    }
    let data = memory.data(ctx);
    let start = match usize::try_from(ptr) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let end = match start.checked_add(len as usize) {
        Some(v) => v,
        None => return String::new(),
    };
    if end <= data.len() {
        String::from_utf8_lossy(&data[start..end]).into_owned()
    } else {
        String::new()
    }
}

pub type SharedBotInstance = Arc<BotInstance>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_str_refuses_guest_controlled_integer_overflow() {
        // ptr=i32::MAX, len=10: start + len wraps in usize-free code but the
        // OLD version did `start + len as usize` unchecked... on 64-bit that
        // particular case survives, so pin the actually dangerous one:
        // negative len (guest i32) and huge len.
        let engine = Engine::new(&Config::new()).unwrap();
        let mut store = Store::new(&engine, ());
        let memory = Memory::new(&mut store, MemoryType::new(1, None)).unwrap();
        let neg = mem_str(&memory, &store, 0, -5);
        assert_eq!(neg, "");
        let huge = mem_str(&memory, &store, 0, i32::MAX);
        assert_eq!(huge, "");
        let oob = mem_str(&memory, &store, i32::MAX - 1, 100);
        assert_eq!(oob, "");
    }
}

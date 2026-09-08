//! Wasmtime fuel: turning "how long may this guest run?" into a number.
//!
//! Fuel is wasmtime's DETERMINISTIC instruction metering. With
//! `consume_fuel(true)` on the Engine, every executed wasm instruction costs a
//! fixed amount and, when a Store's fuel hits zero, the guest TRAPS instead of
//! looping forever. That is the whole point: you cannot hang a clean wall-clock
//! alarm on synchronous wasm execution, so you budget *work* (instructions) as
//! a proxy for *time*. A bounded fuel value bounds the guest's runtime and
//! guarantees termination against infinite loops regardless of host clock
//! speed — same module, same fuel, same instruction count, on any machine.
//!
//! The two free functions below are the ones instance.rs actually uses. NOTE:
//! `FuelMeter` (the struct) is NOT part of that path — it is an unwired
//! parallel counter that nothing constructs; `BotInstance::add_fuel` goes
//! straight to wasmtime's store fuel. Treat `FuelMeter` as dead scaffolding
//! for a future per-callback metering policy, not as a source of truth.

use crate::error::Result;
use parking_lot::RwLock;
use wasmtime::{Config, Engine, Store};

pub struct FuelMeter {
    max_fuel: u64,
    consumed: RwLock<u64>,
}

impl FuelMeter {
    pub fn new(max_fuel: u64, _engine: &Engine) -> Self {
        Self {
            max_fuel,
            consumed: RwLock::new(0),
        }
    }

    /// NOTE (looks like the limits.rs bug, is not): `consumed` is incremented
    /// BEFORE the cap check, the exact check-after-mutate shape the old
    /// ResourceLimiter had. It is harmless HERE because this counter has no
    /// release path — once it passes `max_fuel` it stays past it and
    /// `remaining()` clamps to 0, so the over-count can never un-poison a
    /// later legitimate ask the way inflating a reusable budget did. It is
    /// also dead scaffolding (module doc), so the ordering is not load-bearing
    /// either way; if you wire this type, prefer check-then-mutate for clarity.
    pub fn consume_fuel(&self, amount: u64) -> Result<()> {
        let mut consumed = self.consumed.write();
        *consumed += amount;
        if *consumed > self.max_fuel {
            return Err(crate::error::BotRuntimeError::ResourceLimitExceeded(
                format!(
                    "Fuel limit exceeded: consumed {} / {}",
                    *consumed, self.max_fuel
                ),
            ));
        }
        Ok(())
    }

    pub fn get_consumed(&self) -> u64 {
        *self.consumed.read()
    }

    pub fn reset(&self) {
        *self.consumed.write() = 0;
    }

    pub fn remaining(&self) -> u64 {
        let consumed = *self.consumed.read();
        self.max_fuel.saturating_sub(consumed)
    }
}

/// Build the shared Engine: fuel metering ON (see module doc), async support
/// (the host is tokio-based and the lifecycle ABI is meant to be delivered
/// async — the flag MUST be decided here because a Config cannot be toggled
/// after `Engine::new`), parallel compilation, and full wasm backtraces so a
/// guest trap is debuggable instead of a bare "unreachable executed".
pub fn create_engine() -> Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.parallel_compilation(true);
    config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);
    config.async_support(true);
    Engine::new(&config).map_err(crate::error::BotRuntimeError::Wasm)
}

/// Top up a Store's fuel budget. wasmtime DECREASES fuel as the guest runs, so
/// a long-lived store must be refuelled between lifecycle calls. We read the
/// current balance and ADD to it rather than overwrite: setting a constant
/// would silently refund fuel already spent (or starve a guest mid-flight).
/// Both calls error if this engine was built without `consume_fuel(true)`,
/// which is exactly what `create_engine` guarantees.
pub fn add_fuel_to_store(store: &mut Store<()>, amount: u64) -> Result<()> {
    let current = store
        .get_fuel()
        .map_err(crate::error::BotRuntimeError::Wasm)?;
    store
        .set_fuel(current + amount)
        .map_err(crate::error::BotRuntimeError::Wasm)
}

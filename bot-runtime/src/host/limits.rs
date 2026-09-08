use crate::error::Result;
use crate::manifest::BotCapabilities;
use parking_lot::RwLock;
use std::sync::Arc;

pub struct ResourceLimiter {
    capabilities: BotCapabilities,
    memory_used: RwLock<u64>,
    peak_memory: RwLock<u64>,
}

impl ResourceLimiter {
    pub fn new(capabilities: BotCapabilities) -> Self {
        Self {
            capabilities,
            memory_used: RwLock::new(0),
            peak_memory: RwLock::new(0),
        }
    }

    /// Admission check for `additional_bytes`.
    ///
    /// The old implementation mutated `memory_used` BEFORE comparing against
    /// the cap, then returned Err — so every rejected allocation permanently
    /// inflated the counter anyway. A guest that tried (and was denied) 65
    /// 1-megabyte blocks would have exhausted the budget of the NEXT guest
    /// that asked for one legitimate byte. Check first, mutate on success:
    /// the boring order that actually matters.
    pub fn check_memory(&self, additional_bytes: u64) -> Result<()> {
        let max_bytes = self.capabilities.max_memory_mb as u64 * 1024 * 1024;
        let mut used = self.memory_used.write();
        let proposed = used.saturating_add(additional_bytes);
        if proposed > max_bytes {
            return Err(crate::error::BotRuntimeError::ResourceLimitExceeded(
                format!(
                    "Memory limit exceeded: {} MB / {} MB",
                    proposed / 1024 / 1024,
                    self.capabilities.max_memory_mb
                ),
            ));
        }
        *used = proposed;
        let mut peak = self.peak_memory.write();
        if *used > *peak {
            *peak = *used;
        }
        Ok(())
    }

    pub fn release_memory(&self, bytes: u64) {
        let mut used = self.memory_used.write();
        *used = used.saturating_sub(bytes);
    }

    pub fn get_memory_used(&self) -> u64 {
        *self.memory_used.read()
    }

    pub fn get_peak_memory(&self) -> u64 {
        *self.peak_memory.read()
    }

    pub fn get_max_memory(&self) -> u64 {
        self.capabilities.max_memory_mb as u64 * 1024 * 1024
    }
}

impl Default for ResourceLimiter {
    fn default() -> Self {
        Self::new(BotCapabilities::default())
    }
}

pub type SharedResourceLimiter = Arc<ResourceLimiter>;
#[cfg(test)]
mod tests {
    use super::*;

    fn limiter(max_mb: u32) -> ResourceLimiter {
        ResourceLimiter::new(BotCapabilities {
            max_memory_mb: max_mb,
            ..Default::default()
        })
    }

    #[test]
    fn rejected_allocation_does_not_move_the_counter() {
        let l = limiter(1);
        assert!(l.check_memory(2 * 1024 * 1024).is_err());
        // THE regression: the old code left memory_used at 2 MB after denial.
        assert_eq!(l.get_memory_used(), 0);
        // ...which is what made the next 512 KB ask fail as well:
        assert!(l.check_memory(512 * 1024).is_ok());
        assert_eq!(l.get_memory_used(), 512 * 1024);
        assert_eq!(l.get_peak_memory(), 512 * 1024);
        l.release_memory(512 * 1024);
        assert_eq!(l.get_memory_used(), 0);
    }
}

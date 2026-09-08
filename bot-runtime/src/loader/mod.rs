//! Language loaders: source → wasm32-unknown-unknown module.
//!
//! EXPERIMENTAL: none of these paths has ever produced a module that the
//! host can instantiate — the "env" ABI in runtime/instance.rs has no guest
//! SDK yet. The loaders exist as the intended shape of the compile pipeline;
//! each `compile` that cannot honestly work returns an error instead of
//! pretending (see javascript.rs, which used to invoke `esbuild
//! --target=wasm` — esbuild HAS NO wasm target; it could never emit
//! anything, and the only reason nobody noticed is that the output-path
//! check downstream would have caught the empty success).

use crate::error::Result;
use crate::manifest::{BotLanguage, BotManifest};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

pub mod assemblyscript;
pub mod javascript;
pub mod python;
pub mod rust;

pub use assemblyscript::AssemblyScriptLoader;
pub use javascript::JavaScriptLoader;
pub use python::PythonLoader;
pub use rust::RustLoader;

pub trait LanguageLoader: Send + Sync {
    fn language(&self) -> BotLanguage;
    fn compile(&self, source_path: &Path, output_path: &Path) -> Result<()>;
    fn validate_source(&self, source_path: &Path) -> Result<()>;
    fn generate_manifest(
        &self,
        source_path: &Path,
        config: HashMap<String, serde_json::Value>,
    ) -> Result<BotManifest>;
}

pub fn get_loader(language: BotLanguage) -> Arc<dyn LanguageLoader> {
    match language {
        BotLanguage::Python => Arc::new(PythonLoader::new()),
        BotLanguage::JavaScript => Arc::new(JavaScriptLoader::new()),
        BotLanguage::Rust => Arc::new(RustLoader::new()),
        BotLanguage::AssemblyScript => Arc::new(AssemblyScriptLoader::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_maps_to_a_loader() {
        for lang in [
            BotLanguage::Python,
            BotLanguage::JavaScript,
            BotLanguage::Rust,
            BotLanguage::AssemblyScript,
        ] {
            assert_eq!(get_loader(lang).language(), lang);
        }
    }
}

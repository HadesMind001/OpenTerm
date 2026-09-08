//! AssemblyScript loader — `asc` CLI wrapper.
//!
//! Split out of loader/mod.rs where it lived as the only loader without its
//! own file, because reasons. `asc` must be on PATH (npm i -g assemblyscript).

use crate::error::{BotRuntimeError, Result};
use crate::loader::LanguageLoader;
use crate::manifest::{BotCapabilities, BotLanguage, BotManifest, BotMetadata};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

pub struct AssemblyScriptLoader;

impl AssemblyScriptLoader {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AssemblyScriptLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl LanguageLoader for AssemblyScriptLoader {
    fn language(&self) -> BotLanguage {
        BotLanguage::AssemblyScript
    }

    fn compile(&self, source_path: &Path, output_path: &Path) -> Result<()> {
        let status = Command::new("asc")
            .arg(source_path)
            .args(["--target", "release", "--outFile"])
            .arg(output_path)
            .status()
            .map_err(|e| BotRuntimeError::CompilationFailed(format!("asc not available: {e}")))?;

        if !status.success() {
            return Err(BotRuntimeError::CompilationFailed(
                "AssemblyScript compilation failed".to_string(),
            ));
        }
        if !output_path.exists() {
            return Err(BotRuntimeError::CompilationFailed(
                "WASM output file was not created".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_source(&self, source_path: &Path) -> Result<()> {
        if !source_path.exists() {
            return Err(BotRuntimeError::InvalidManifest(
                "Source file not found".to_string(),
            ));
        }
        Ok(())
    }

    fn generate_manifest(
        &self,
        source_path: &Path,
        config: HashMap<String, serde_json::Value>,
    ) -> Result<BotManifest> {
        let name = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("bot")
            .to_string();

        Ok(BotManifest {
            bot: BotMetadata {
                name,
                version: "1.0.0".to_string(),
                language: BotLanguage::AssemblyScript,
                entrypoint: "main".to_string(),
                description: None,
                author: None,
            },
            capabilities: BotCapabilities::default(),
            config,
        })
    }
}

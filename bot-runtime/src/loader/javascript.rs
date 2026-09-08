use crate::error::Result;
use crate::loader::LanguageLoader;
use crate::manifest::{BotCapabilities, BotLanguage, BotManifest, BotMetadata};
use std::collections::HashMap;
use std::path::Path;

pub struct JavaScriptLoader;

impl JavaScriptLoader {
    pub fn new() -> Self {
        Self
    }
}

impl Default for JavaScriptLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl LanguageLoader for JavaScriptLoader {
    fn language(&self) -> BotLanguage {
        BotLanguage::JavaScript
    }

    fn compile(&self, _source_path: &Path, _output_path: &Path) -> Result<()> {
        // WHAT THE FUTURE, IF YOU'RE READING THIS AFTER "FIXING" IT BACK:
        // this used to run `esbuild --target=wasm`. esbuild DOES NOT HAVE A
        // WASM TARGET. It was never going to emit a module; the command
        // failed or produced JS while the existence-check downstream would
        // have passed on garbage. Compiling JS to wasm for this ABI needs a
        // real pipeline (e.g. Javy, workerd-style embeddings, or
        // AssemblyScript for the typed subset) plus a guest that exports the
        // env.* lifecycle functions. None of that exists. Error, loudly,
        // until it does.
        Err(crate::error::BotRuntimeError::CompilationFailed(
            "JavaScript -> WASM toolchain not implemented (esbuild cannot emit wasm). \
             See bot-runtime/README.md \"contributing: loaders\"."
                .to_string(),
        ))
    }

    fn validate_source(&self, source_path: &Path) -> Result<()> {
        if !source_path.exists() {
            return Err(crate::error::BotRuntimeError::InvalidManifest(
                "Source file not found".to_string(),
            ));
        }

        if source_path.extension().and_then(|s| s.to_str()) != Some("js")
            && source_path.extension().and_then(|s| s.to_str()) != Some("ts")
        {
            return Err(crate::error::BotRuntimeError::InvalidManifest(
                "JavaScript source file must have .js or .ts extension".to_string(),
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
                name: name.clone(),
                version: "1.0.0".to_string(),
                language: BotLanguage::JavaScript,
                entrypoint: "default".to_string(),
                description: None,
                author: None,
            },
            capabilities: BotCapabilities::default(),
            config,
        })
    }
}

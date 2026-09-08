//! Python loader — py2wasm detection + compile wrapper. **EXPERIMENTAL SKELETON**.
//!
//! HONEST STATE OF THE WORLD: none of the tools probed below is a maintained,
//! working Python -> wasm compiler on modern CPython. This loader is a
//! discovery dance around a tool that mostly does not exist: it looks for
//! *some* `py2wasm` on PATH and, only if it finds one, invokes it. When none
//! is found (the normal case), `find_py2wasm` returns None and `compile` fails
//! with a loud, unwrap-free `CompilationFailed` (see `get_py2wasm_cmd`) — it
//! does NOT panic on a missing tool, which is the whole point of returning an
//! error rather than `unwrap`/`expect`-ing the Option.
//!
//! EVEN IF A MODULE APPEARED, IT WOULD NOT RUN: the host (runtime/instance.rs)
//! drives a guest only through the `env.*` lifecycle ABI — export `memory` plus
//! on_start / on_bar / on_quote / on_trade / on_fill / on_timer / on_signal. A
//! py2wasm artifact is a bundled CPython interpreter, not such a module, so it
//! would fail to instantiate. See bot-runtime/README.md "Contributing: loaders".
//! The class name `extract_entrypoint` finds goes into `manifest.bot.entrypoint`,
//! but the host resolves lifecycle by the fixed export NAMES above, not by this
//! field — every loader's entrypoint string ("main" / "default" / class name) is
//! informational. Nothing reads it.
//!
//! Separately, `validate_source` genuinely works: `python3 -m py_compile` is
//! stdlib, so the syntax check is real even though the compile step is a stub.

use crate::error::Result;
use crate::loader::LanguageLoader;
use crate::manifest::{BotCapabilities, BotLanguage, BotManifest, BotMetadata};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use tracing::{debug, info};

pub struct PythonLoader {
    py2wasm_path: Option<String>,
}

impl PythonLoader {
    pub fn new() -> Self {
        Self {
            py2wasm_path: Self::find_py2wasm(),
        }
    }

    fn find_py2wasm() -> Option<String> {
        // Probed in order; every entry is best-effort and, today, most likely
        // absent: "py2wasm" (no maintained tool by that name),
        // "wasmer-py2wasm" (the old AOT Py2Wasm project — unmaintained, does
        // not track current CPython), "python3 -m py2wasm" (no such module).
        // A "hit" just means the binary answered `--version` with status 0;
        // absence is the norm and is turned into a clear error, never a panic.
        let candidates = ["py2wasm", "wasmer-py2wasm", "python3 -m py2wasm"];

        for candidate in candidates {
            let parts: Vec<&str> = candidate.split_whitespace().collect();
            let status = Command::new(parts[0])
                .args(&parts[1..])
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();

            if status.is_ok_and(|s| s.success()) {
                return Some(candidate.to_string());
            }
        }
        None
    }

    /// Build the py2wasm command, or a loud error when the tool was never
    /// found. This is the anti-unwrap: a missing compiler is an
    /// `Err(CompilationFailed)`, never a panic — the Option is handled, not
    /// `expect`ed, so `cargo run -- deploy bot.py` fails cleanly instead of
    /// taking the process down on `None`.
    fn get_py2wasm_cmd(&self) -> Result<Command> {
        if let Some(ref path) = self.py2wasm_path {
            let parts: Vec<&str> = path.split_whitespace().collect();
            let mut cmd = Command::new(parts[0]);
            cmd.args(&parts[1..]);
            Ok(cmd)
        } else {
            Err(crate::error::BotRuntimeError::CompilationFailed(
                "py2wasm not found. Install with: pip install wasmer-py2wasm".to_string(),
            ))
        }
    }
}

impl LanguageLoader for PythonLoader {
    fn language(&self) -> BotLanguage {
        BotLanguage::Python
    }

    fn compile(&self, source_path: &Path, output_path: &Path) -> Result<()> {
        info!(
            "Compiling Python bot: {} -> {}",
            source_path.display(),
            output_path.display()
        );

        let mut cmd = self.get_py2wasm_cmd()?;

        let output = cmd.arg(source_path).arg("-o").arg(output_path).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            debug!("py2wasm stderr: {}", stderr);
            return Err(crate::error::BotRuntimeError::CompilationFailed(format!(
                "py2wasm compilation failed: {}",
                stderr
            )));
        }

        // Verify output was created
        if !output_path.exists() {
            return Err(crate::error::BotRuntimeError::CompilationFailed(
                "WASM output file was not created".to_string(),
            ));
        }

        info!("Successfully compiled Python bot to WASM");
        Ok(())
    }

    fn validate_source(&self, source_path: &Path) -> Result<()> {
        if !source_path.exists() {
            return Err(crate::error::BotRuntimeError::InvalidManifest(
                "Source file not found".to_string(),
            ));
        }

        // Check if it's a Python file
        if source_path.extension().and_then(|s| s.to_str()) != Some("py") {
            return Err(crate::error::BotRuntimeError::InvalidManifest(
                "Python source file must have .py extension".to_string(),
            ));
        }

        // Try to parse with Python to check syntax.
        // (was: source_path.to_str().unwrap() — a non-UTF-8 path from a CLI
        // arg panicked in the loader; OsStr args need no lossy round-trip.)
        let output = Command::new("python3")
            .args(["-m", "py_compile"])
            .arg(source_path)
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(crate::error::BotRuntimeError::InvalidManifest(format!(
                "Python syntax error: {}",
                stderr
            )));
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

        // Try to extract class name from source
        let entrypoint = extract_entrypoint(source_path)?;

        Ok(BotManifest {
            bot: BotMetadata {
                name: name.clone(),
                version: "1.0.0".to_string(),
                language: BotLanguage::Python,
                entrypoint,
                description: None,
                author: None,
            },
            capabilities: BotCapabilities::default(),
            config,
        })
    }
}

fn extract_entrypoint(source_path: &Path) -> Result<String> {
    let content = std::fs::read_to_string(source_path)?;

    // Look for class definitions that might be bot entrypoints
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("class ") {
            if let Some(class_name) = trimmed
                .strip_prefix("class ")
                .and_then(|s| s.split('(').next())
                .and_then(|s| s.split(':').next())
            {
                let class_name = class_name.trim();
                // Check if it looks like a bot class
                if class_name.to_lowercase().contains("bot")
                    || class_name.to_lowercase().contains("strategy")
                    || class_name.ends_with("Bot")
                    || class_name.ends_with("Strategy")
                {
                    return Ok(class_name.to_string());
                }
            }
        }
    }

    // Default to first class found or "Bot"
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("class ") {
            if let Some(class_name) = trimmed
                .strip_prefix("class ")
                .and_then(|s| s.split('(').next())
                .and_then(|s| s.split(':').next())
            {
                return Ok(class_name.trim().to_string());
            }
        }
    }

    Ok("Bot".to_string())
}

impl Default for PythonLoader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_python_loader_creation() {
        let loader = PythonLoader::new();
        assert_eq!(loader.language(), BotLanguage::Python);
    }

    #[tokio::test]
    async fn test_python_validation() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("test_bot.py");
        fs::write(
            &source,
            r#"
class TestBot:
    async def on_start(self, ctx):
        pass
    async def on_bar(self, ctx, bar):
        pass
"#,
        )
        .unwrap();

        let loader = PythonLoader::new();
        // The old test called `let _ = loader.validate_source(&source);` —
        // DISCARDING the result so it passed whether validation worked or
        // not. A test that cannot fail is not a test. py_compile is part of
        // stdlib; python3 on PATH is a fair CI assumption (github runners
        // ship it; the local dev box does too).
        loader
            .validate_source(&source)
            .expect("valid python must validate (is python3 on PATH?)");
        let manifest = loader.generate_manifest(&source, HashMap::new()).unwrap();
        assert_eq!(manifest.bot.entrypoint, "TestBot", "class discovery broke");
    }
}

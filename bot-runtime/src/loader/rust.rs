use crate::error::Result;
use crate::loader::LanguageLoader;
use crate::manifest::{BotCapabilities, BotLanguage, BotManifest, BotMetadata};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

pub struct RustLoader;

impl RustLoader {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RustLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl LanguageLoader for RustLoader {
    fn language(&self) -> BotLanguage {
        BotLanguage::Rust
    }

    fn compile(&self, source_path: &Path, output_path: &Path) -> Result<()> {
        // source_path should be a directory containing Cargo.toml
        let project_dir = if source_path.is_dir() {
            source_path
        } else {
            source_path.parent().unwrap_or(source_path)
        };

        // ⚠ THIS RUNS ARBITRARY CODE: `cargo build` executes build.rs of the
        // project (and of any dependency) with FULL user privileges. For a
        // LOCAL dev workflow that's just "you ran cargo"; for the day bots
        // can be deployed over a network, this exact line is the RCE. The
        // deploy path (bot_manager/api) currently stores source as text and
        // never calls compile() — keep it that way until a sandboxed build
        // (user namespace / container / CI runner) is designed in.
        let status = Command::new("cargo")
            .current_dir(project_dir)
            .args(["build", "--target", "wasm32-unknown-unknown", "--release"])
            .status()?;

        if !status.success() {
            return Err(crate::error::BotRuntimeError::CompilationFailed(
                "cargo build failed".to_string(),
            ));
        }

        // Artifact name is the CARGO PACKAGE name, not the directory name —
        // the old assumption (dir == crate name) silently failed for every
        // repo where they differ. Minimal parse; switch to the `toml` crate
        // if this ever needs to be robust (it should not live long anyway).
        let pkg_name = package_name(project_dir).unwrap_or_else(|| {
            project_dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("bot")
                .to_string()
        });

        let wasm_path = project_dir
            .join("target")
            .join("wasm32-unknown-unknown")
            .join("release")
            .join(format!("{pkg_name}.wasm"));

        if !wasm_path.exists() {
            return Err(crate::error::BotRuntimeError::CompilationFailed(
                "WASM output file not found after cargo build".to_string(),
            ));
        }

        // Copy to output path
        std::fs::copy(&wasm_path, output_path)?;

        Ok(())
    }

    fn validate_source(&self, source_path: &Path) -> Result<()> {
        let cargo_toml = if source_path.is_dir() {
            source_path.join("Cargo.toml")
        } else {
            source_path
                .parent()
                .unwrap_or(source_path)
                .join("Cargo.toml")
        };

        if !cargo_toml.exists() {
            return Err(crate::error::BotRuntimeError::InvalidManifest(
                "Rust project must have Cargo.toml".to_string(),
            ));
        }

        // Presence of [package] is the only meaningful local check; the
        // old empty `if` block that "warned" about the wasm target was an
        // if-statement doing literally nothing.
        let content = std::fs::read_to_string(&cargo_toml)?;
        if !content.contains("[package]") && !content.contains("[lib]") {
            return Err(crate::error::BotRuntimeError::InvalidManifest(
                "Cargo.toml has no [package] or [lib] section".to_string(),
            ));
        }

        Ok(())
    }

    fn generate_manifest(
        &self,
        source_path: &Path,
        config: HashMap<String, serde_json::Value>,
    ) -> Result<BotManifest> {
        let name = if source_path.is_dir() {
            source_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("bot")
        } else {
            source_path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .unwrap_or("bot")
        };

        let name = name.to_string();

        Ok(BotManifest {
            bot: BotMetadata {
                name: name.clone(),
                version: "1.0.0".to_string(),
                language: BotLanguage::Rust,
                entrypoint: "main".to_string(),
                description: None,
                author: None,
            },
            capabilities: BotCapabilities::default(),
            config,
        })
    }
}
/// Very small Cargo.toml reader for `[package] name = "..."`.
/// (Deliberately no toml dependency for a 12-line lookup.)
fn package_name(project_dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(project_dir.join("Cargo.toml")).ok()?;
    let mut in_package = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package {
            if let Some(rest) = line.strip_prefix("name") {
                let rest = rest.trim_start();
                if let Some(rest) = rest.strip_prefix('=') {
                    let name = rest.trim().trim_matches('"').trim_matches('\'');
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn package_name_parsed_from_manifest() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"my-cool-bot\"\nversion = \"0.1.0\"\n\n[dependencies]\nserde = \"1\"\n",
        )
        .unwrap();
        assert_eq!(package_name(dir.path()).as_deref(), Some("my-cool-bot"));
    }
}

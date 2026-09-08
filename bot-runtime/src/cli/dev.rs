use crate::cli::{not_implemented, sanitize_bot_name};
use crate::error::Result;
use std::path::PathBuf;

pub async fn run(source: PathBuf, name: Option<String>) -> Result<()> {
    let raw = name.unwrap_or_else(|| {
        source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("bot")
            .to_string()
    });
    let bot_name = sanitize_bot_name(&raw)?;
    eprintln!("dev: {bot_name} watching {}", source.display());
    Err(not_implemented("dev (hot reload)"))
}

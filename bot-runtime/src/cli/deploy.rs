use crate::cli::{not_implemented, sanitize_bot_name};
use crate::error::Result;
use std::path::PathBuf;

pub async fn run(source: PathBuf, name: Option<String>, risk: String, _force: bool) -> Result<()> {
    let raw = name.unwrap_or_else(|| {
        source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("bot")
            .to_string()
    });
    // Names become directory components under the bot dir. The old code used
    // file_stem() raw — "../../evil" as a filename would have walked the
    // deploy target tree. Sanitized before it can ever be a path.
    let bot_name = sanitize_bot_name(&raw)?;
    let _ = risk;
    eprintln!("deploy: {bot_name} from {}", source.display());
    Err(not_implemented("deploy"))
}

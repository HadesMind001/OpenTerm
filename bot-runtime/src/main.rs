//! Binary entry point.
//!
//! This used to `mod`-declare every module privately and duplicate the whole
//! crate — so the binary's BotState was literally a different type from the
//! library's, and anything compiled twice diverged the moment they changed
//! only one copy. The binary is now a 15-line shell over `openterm_bot_runtime`.

use clap::Parser;
use openterm_bot_runtime::cli::{run, Cli};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();

    // Default bot dir: $XDG_DATA_HOME/openterm/bots (dirs crate handles it).
    // --bot-dir is operator input, but we still log exactly what we create;
    // an unexpected `create_dir_all` is how stray directories like the
    // infamous `646735{HOME}` get born (see repo history before you laugh —
    // it was us).
    let bot_dir = cli.bot_dir.clone().unwrap_or_else(|| {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("openterm")
            .join("bots")
    });
    if let Err(e) = std::fs::create_dir_all(&bot_dir) {
        eprintln!("cannot create bot dir {}: {e}", bot_dir.display());
        return std::process::ExitCode::FAILURE;
    }

    if let Err(e) = run(cli).await {
        eprintln!("error: {e}");
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}

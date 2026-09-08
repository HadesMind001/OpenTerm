mod build;
mod deploy;
mod dev;
mod list;
mod logs;
mod start;
mod status;
mod stop;

use crate::error::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "openterm-bot")]
#[command(about = "OpenTerm WASM Bot Runtime", long_about = None)]
#[command(version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,

    /// Bot directory (defaults to ~/.local/share/openterm/bots/<name>)
    #[arg(short, long, global = true)]
    pub bot_dir: Option<PathBuf>,

    /// Enable debug logging
    #[arg(short, long, global = true)]
    pub debug: bool,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Deploy a bot from source code
    Deploy {
        /// Path to source file (Python, JS, Rust, AssemblyScript)
        source: PathBuf,
        /// Bot name (defaults to source filename)
        #[arg(short, long)]
        name: Option<String>,
        /// Risk profile (conservative, moderate, aggressive)
        #[arg(long, default_value = "moderate")]
        risk: String,
        /// Force overwrite existing bot
        #[arg(long)]
        force: bool,
    },

    /// Start a deployed bot
    Start {
        /// Bot name or ID
        name: String,
    },

    /// Stop a running bot
    Stop {
        /// Bot name or ID
        name: String,
    },

    /// Show bot status
    Status {
        /// Bot name or ID (shows all if omitted)
        name: Option<String>,
    },

    /// Show bot logs
    Logs {
        /// Bot name or ID
        name: String,
        /// Follow logs
        #[arg(short, long)]
        follow: bool,
        /// Number of lines to show
        #[arg(short, long, default_value = "100")]
        lines: usize,
    },

    /// Development mode with hot reload
    Dev {
        /// Path to source file
        source: PathBuf,
        /// Bot name
        #[arg(short, long)]
        name: Option<String>,
    },

    /// Build bot to WASM (AOT compilation)
    Build {
        /// Path to source file
        source: PathBuf,
        /// Output directory
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Optimization level
        #[arg(long, default_value = "speed")]
        opt: String,
    },

    /// List all deployed bots
    List,
}

/// Every subcommand funnels through this until the runtime is real.
///
/// These commands used to `println!("Deployed successfully!")` and return
/// Ok with zero work done — an exit code of 0 telling scripts and humans
/// that a deploy happened when it emphatically did not. Fake success is the
/// most expensive kind of bug: it is trusted. Now: honest error, exit 1.
pub(crate) fn not_implemented(what: &str) -> crate::error::BotRuntimeError {
    crate::error::BotRuntimeError::NotImplemented(format!(
        "{what} — the WASM bot runtime is EXPERIMENTAL scaffolding and does not execute bots yet (see bot-runtime/README.md)"
    ))
}

/// Bot names become path components; keep them boring.
pub(crate) fn sanitize_bot_name(raw: &str) -> crate::error::Result<String> {
    let name: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches('-').to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(crate::error::BotRuntimeError::InvalidManifest(format!(
            "bot name {raw:?} is empty or > 64 chars after sanitizing"
        )));
    }
    Ok(name)
}

pub async fn run(cli: Cli) -> Result<()> {
    if cli.debug {
        std::env::set_var("RUST_LOG", "debug");
    }
    tracing_subscriber::fmt::init();

    match cli.command {
        Commands::Deploy {
            source,
            name,
            risk,
            force,
        } => deploy::run(source, name, risk, force).await,
        Commands::Start { name } => start::run(name).await,
        Commands::Stop { name } => stop::run(name).await,
        Commands::Status { name } => status::run(name).await,
        Commands::Logs {
            name,
            follow,
            lines,
        } => logs::run(name, follow, lines).await,
        Commands::Dev { source, name } => dev::run(source, name).await,
        Commands::Build {
            source,
            output,
            opt,
        } => build::run(source, output, opt).await,
        Commands::List => list::run().await,
    }
}

use crate::cli::not_implemented;
use crate::error::Result;

pub async fn run(name: Option<String>) -> Result<()> {
    Err(not_implemented(&match name {
        Some(n) => format!("status {n}"),
        None => "status (all bots)".to_string(),
    }))
}

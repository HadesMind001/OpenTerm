use crate::cli::not_implemented;
use crate::error::Result;

pub async fn run(name: String, follow: bool, lines: usize) -> Result<()> {
    Err(not_implemented(&format!(
        "logs {name} (follow={follow}, lines={lines})"
    )))
}

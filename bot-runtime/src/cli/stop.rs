use crate::cli::not_implemented;
use crate::error::Result;

pub async fn run(name: String) -> Result<()> {
    Err(not_implemented(&format!("stop {name}")))
}

use crate::cli::not_implemented;
use crate::error::Result;
use std::path::PathBuf;

pub async fn run(source: PathBuf, _output: Option<PathBuf>, _opt: String) -> Result<()> {
    Err(not_implemented(&format!("build {}", source.display())))
}

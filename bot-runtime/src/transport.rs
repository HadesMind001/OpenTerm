//! Unix-socket JSON-lines transport between the (future) Python app client
//! and this runtime.
//!
//! Protocol: one `BotRequest` JSON per line inbound, one `BotResponse` per
//! line outbound (`openterm_bot_protocol` tagged enums).
//!
//! SECURITY POSTURE — read before touching:
//!   * The socket is unauthenticated. Anyone with filesystem access to the
//!     socket path can order trades *as soon as order routing exists*. We
//!     therefore create it 0600 and refuse to delete files we did not create
//!     (the old code unlinked ANY existing path at bind time — trivial
//!     arbitrary-file-deletion if a socket path ever collides with something
//!     real).
//!   * Inbound lines are hard-capped: `read_line` with no limit meant one
//!     unterminated line from a buggy client OOM'd the runtime.
//!   * process_request used to answer GetStatus with a FABRICATED
//!     `{state: Running, started_at: now}` and GetBars/GetQuote with empty
//!     "success". A caller could not distinguish "no bots" from "runtime
//!     possessed" — every unimplemented method now returns an explicit
//!     Unsupported error. Faking health is how experimental code gets shipped.

use crate::error::{BotRuntimeError, Result};
use openterm_bot_protocol::{BotEvent, BotRequest, BotResponse};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{error, info, warn};

/// 1 MiB per request line. Real requests are <10 KB unless someone deploys
/// a wasm module inline (Deploy.wasm_bytes is JSON-encoded — 6 MB module
/// becomes ~30 MB of JSON; that request type deserves a binary framing
/// discussion, not a silent cap raise).
const MAX_LINE_BYTES: usize = 1024 * 1024;

pub type BotSender = mpsc::UnboundedSender<BotRequest>;
pub type BotReceiver = mpsc::UnboundedReceiver<BotRequest>;
pub type EventSender = broadcast::Sender<BotEvent>;
pub type EventReceiver = broadcast::Receiver<BotEvent>;

/// Client-side handle: send requests on `request_tx`, read responses from
/// `next_response()`. Events are not streamed to in-process handles.
pub struct TransportHandle {
    request_tx: BotSender,
    response_rx: Arc<Mutex<mpsc::UnboundedReceiver<BotResponse>>>,
}

impl TransportHandle {
    pub async fn next_response(&self) -> Option<BotResponse> {
        self.response_rx.lock().await.recv().await
    }

    /// Cloneable sender for pushing requests onto the socket. Without an
    /// accessor the private field was literally unusable — the "handle" was
    /// a receipt you could only read from.
    pub fn requests(&self) -> BotSender {
        self.request_tx.clone()
    }
}

pub struct TransportServer {
    socket_path: PathBuf,
    event_tx: EventSender,
}

impl TransportServer {
    pub fn new(socket_path: PathBuf) -> Self {
        let (event_tx, _) = broadcast::channel(1024);
        Self {
            socket_path,
            event_tx,
        }
    }

    pub fn subscribe_events(&self) -> EventReceiver {
        self.event_tx.subscribe()
    }

    pub async fn broadcast_event(&self, event: BotEvent) {
        // No listeners is normal; no reason to log or fail.
        let _ = self.event_tx.send(event);
    }

    pub async fn run(&self) -> Result<()> {
        // Refuse to clobber anything that is not a stale socket. `remove_file`
        // on a regular file the operator kept at this path (typo'd config) is
        // data loss; AddrInUse deserves an honest error instead.
        match std::fs::metadata(&self.socket_path) {
            Ok(md) => {
                use std::os::unix::fs::FileTypeExt;
                if md.file_type().is_socket() {
                    std::fs::remove_file(&self.socket_path)?;
                } else {
                    return Err(BotRuntimeError::InvalidConfig(format!(
                        "refusing to bind: {} exists and is not a socket",
                        self.socket_path.display()
                    )));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let listener = UnixListener::bind(&self.socket_path)?;
        // 0600: owner-only. The default umask-777-derived perms left the
        // socket group/world-writable on many distros.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.socket_path, std::fs::Permissions::from_mode(0o600))?;
        }
        info!("transport listening on {:?}", self.socket_path);

        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let events = self.event_tx.clone();
                    tokio::spawn(async move {
                        if let Err(e) = Self::handle_connection(stream, events).await {
                            error!("connection error: {e}");
                        }
                    });
                }
                Err(e) => {
                    // accept() failing in a loop can spam; still the right
                    // shape: log, keep serving. (Binds on unix don't fail
                    // repeatedly except under fd exhaustion — which deserves
                    // the noise.)
                    error!("accept error: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }

    async fn handle_connection(stream: UnixStream, _events: EventSender) -> Result<()> {
        let (rd, mut wr) = stream.into_split();
        // take() enforces the cap per LINE: an oversized request makes
        // read_line return Ok with no newline -> treated as malformed -> bye.
        let mut reader = BufReader::new(rd.take(MAX_LINE_BYTES as u64 + 1));

        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if line.len() > MAX_LINE_BYTES {
                        warn!("oversized request line; closing connection");
                        break;
                    }
                    let request: BotRequest = match serde_json::from_str(line) {
                        Ok(req) => req,
                        Err(e) => {
                            warn!("parse error: {e}");
                            Self::respond(
                                &mut wr,
                                BotResponse::Error {
                                    code: -32700,
                                    message: format!("json parse error: {e}"),
                                },
                            )
                            .await?;
                            continue;
                        }
                    };
                    let response = Self::process_request(request).await;
                    Self::respond(&mut wr, response).await?;
                }
                Err(e) => {
                    error!("read error: {e}");
                    break;
                }
            }
        }
        Ok(())
    }

    async fn respond(writer: &mut OwnedWriteHalf, response: BotResponse) -> Result<()> {
        let json = serde_json::to_string(&response)?;
        writer.write_all(json.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        Ok(())
    }

    async fn process_request(request: BotRequest) -> BotResponse {
        match request {
            BotRequest::Ping => BotResponse::Pong,
            other => BotResponse::Error {
                code: -32601,
                message: format!("not implemented (EXPERIMENTAL runtime): {other:?}"),
            },
        }
    }
}

/// Client connector for the future Python/TS side (in-Rust only today).
pub async fn connect_client(socket_path: PathBuf) -> Result<TransportHandle> {
    let stream = UnixStream::connect(&socket_path).await?;
    let (rd, wr) = stream.into_split();

    let (request_tx, mut request_rx) = mpsc::unbounded_channel::<BotRequest>();
    let (response_tx, response_rx) = mpsc::unbounded_channel::<BotResponse>();

    let writer = Arc::new(Mutex::new(wr));
    {
        let writer = writer.clone();
        tokio::spawn(async move {
            while let Some(request) = request_rx.recv().await {
                let json = match serde_json::to_string(&request) {
                    Ok(j) => j,
                    Err(e) => {
                        error!("cannot serialize request: {e}");
                        continue;
                    }
                };
                let mut w = writer.lock().await;
                if w.write_all(json.as_bytes()).await.is_err()
                    || w.write_all(b"\n").await.is_err()
                    || w.flush().await.is_err()
                {
                    error!("client write failed; terminating send task");
                    break;
                }
            }
        });
    }

    tokio::spawn(async move {
        let mut reader = BufReader::new(rd.take(MAX_LINE_BYTES as u64 + 1));
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.len() > MAX_LINE_BYTES {
                        continue;
                    }
                    match serde_json::from_str::<BotResponse>(trimmed) {
                        Ok(resp) => {
                            if response_tx.send(resp).is_err() {
                                break; // consumer gone
                            }
                        }
                        Err(e) => warn!("bad response from runtime: {e}"),
                    }
                }
                Err(e) => {
                    error!("client read error: {e}");
                    break;
                }
            }
        }
    });

    Ok(TransportHandle {
        request_tx,
        response_rx: Arc::new(Mutex::new(response_rx)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader as StdBufReader, Write};
    use std::os::unix::net::{UnixListener as StdUnixListener, UnixStream as StdUnixStream};
    use tempfile::tempdir;

    /// End-to-end over a REAL socket, purely blocking std::os::unix::net IO.
    ///
    /// This used to be a #[tokio::test] with the server in tokio::spawn —
    /// and it hung FOREVER: the default current_thread runtime cannot run a
    /// blocking `read_line` on the test future and a spawned server task at
    /// the same time, so the server never even reached accept(). Binding the
    /// listener manually (server::run would fight us for the path) and
    /// keeping every fd on plain threads documents the wire format by
    /// example without scheduling landmines.
    #[test]
    fn ping_pong_roundtrip_and_honest_unsupported_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("rt.sock");
        let listener = StdUnixListener::bind(&path).unwrap();

        let server = std::thread::spawn(move || {
            // tiny per-thread runtime: process_request is async but awaits
            // nothing, so this is just a driver, never a scheduler puzzle.
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let (mut writer, mut reader) = loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        break (stream.try_clone().unwrap(), StdBufReader::new(stream));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break, // client gone
                    Ok(_) => {
                        let req: BotRequest = serde_json::from_str(line.trim()).unwrap();
                        let resp = rt.block_on(TransportServer::process_request(req));
                        writeln!(writer, "{}", serde_json::to_string(&resp).unwrap()).unwrap();
                    }
                }
            }
        });

        let mut client = StdUnixStream::connect(&path).unwrap();
        writeln!(
            client,
            "{}",
            serde_json::to_string(&BotRequest::Ping).unwrap()
        )
        .unwrap();
        let mut got = String::new();
        StdBufReader::new(&mut client).read_line(&mut got).unwrap();
        assert!(got.trim().contains("\"Pong\""), "got: {got}");

        writeln!(
            client,
            "{}",
            serde_json::to_string(&BotRequest::Start { bot_id: "x".into() }).unwrap()
        )
        .unwrap();
        got.clear();
        StdBufReader::new(&mut client).read_line(&mut got).unwrap();
        // The key honesty property: unsupported must be an ERROR, never a
        // fabricated success/status.
        assert!(got.contains("Error"), "got: {got}");
        assert!(!got.contains("Running"), "runtime invented health: {got}");
        // dropping `client` closes the socket -> server loop sees EOF -> joins
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn bind_refuses_to_unlink_a_regular_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("not-a-socket");
        std::fs::write(&path, b"important").unwrap();
        let server = TransportServer::new(path.clone());
        let err = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(server.run())
            .unwrap_err();
        assert!(matches!(err, BotRuntimeError::InvalidConfig(_)));
        // and the file survived
        assert_eq!(std::fs::read(&path).unwrap(), b"important");
    }
}

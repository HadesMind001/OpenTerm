# OpenTerm
To be honest this is far from Perfect. I started this as an open source alternative to big expensive tools, and well i never used them so idk if this is nearly as good. But its my baby and i am defenetly not going to stop developement. So well enjoy, give me some feedback if you have some and enjoy my project. 

A local, self-hosted market terminal: FastAPI backend + React frontend, one
process, zero cloud dependencies. Crypto realtime via Binance, equities/ETFs
via Yahoo (unofficial scraping), news via Google News RSS — all streamed to
your browser over one WebSocket, with paper trading, pro charts, screening,
alerts and research.

Optional API keys unlock Finnhub fundamentals/earnings, FRED macro series,
OANDA practice FX streaming, Polygon deep history and an Alpaca paper venue
(see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

![license](https://img.shields.io/badge/license-Apache--2.0-blue)

## Requirementst 

- Python ≥ 3.12
- Node.js (current LTS) + npm
- Optional, only for the experimental bot runtime: a stable Rust toolchain

## Quick start

```bash
make install   # venv + backend (editable) + npm deps
make dev       # backend :8000 + Vite :5173 in an Electron window
make serve     # production-style single process on :8765 (builds frontend first)
```

`make dev`/`make serve` keep their logs under `/tmp/openterm-dev/`. The app
boots into **Market Pulse**: a computed fear/greed gauge, index cards, BTC
volume dominance, movers, and your data-source status.

## Configuration

All API keys are **optional** — the app degrades gracefully and the status bar
tells you what is live.

1. `cp .env.example .env` (gitignored; the backend loads it at boot), **or**
2. export the variables yourself, **or**
3. use the in-app Settings → Keys form, which writes
   `~/.config/openterm/config.json` atomically with mode `0600`. Keys saved
   this way are applied live — no restart needed.

Environment variables take precedence over the config file. Set
`OT_CONFIG_PATH` to relocate the config file (tests use this).

## Use it

- `Ctrl+K` (or `/`) opens the command line: `AAPL`, `APPLE`, `GP TSLA`,
  `DES BTC`, `ALERT ETH above 3000`, `HELP`. Full reference:
  [docs/COMMANDS.md](docs/COMMANDS.md).
- Watchlist rows flash on trades; drag rows into quad-view slots to pin charts.
- B / S buttons open the paper-trading ticket; fills toast live. Market,
  limit, stop and stop-limit orders with slippage + commission — **paper
  money only**, see Known Limitations.
- Tabs: pulse · chart · screen · heatmap · research · alerts · blotter ·
  analytics · journal · settings.

## Development

```bash
make test                     # backend pytest suite
make test-frontend            # vitest
cd frontend && npx tsc --noEmit   # typecheck (also runs inside npm run build)

cd bot-runtime  && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd bot-protocol && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## Project structure

```
backend/openterm/     FastAPI app: core (bus/store/symbols) · providers
                      (binance/yahoo/gnews/finnhub/fred/oanda/polygon/alpaca)
                      · services (broker/bars/alerts/screening/scripting/…)
                      · api (REST + WS gateway)
frontend/             React 19 + Vite + valtio/zustand + lightweight-charts,
                      Electron shell
bot-runtime/          EXPERIMENTAL wasmtime bot runtime (Rust) — executes
                      nothing yet, see its README before touching
bot-protocol/         wire/manifest types shared by the Rust side
docs/                 ARCHITECTURE.md · COMMANDS.md
examples/bots/        strategy sources for the (experimental) bot feature
```

## Known limitations

Honest list, because none of these are bugs to "discover" later:

- **Paper-only float money.** The broker uses floats on purpose (toy money);
  there is no real order routing, and `tif="day"` is not auto-cancelled.
- **Yahoo is an unofficial scrape.** No ToS cover; it can break silently.
- **The Scripts console is NOT a sandbox.** Code runs as a subprocess under
  *your* user (rlimits + env-scrub + timeout, but no isolation from your
  files). Anyone who can reach the endpoint can run code as you.
- **No authentication by design.** The server binds 127.0.0.1 and rejects
  foreign browser origins, but if you bind `0.0.0.0` on a shared network you
  are exposing trades-capable HTTP to your LAN. See [SECURITY.md](SECURITY.md).
- **Bots / the Rust runtime are experimental.** The UI's bot registry manages
  database rows; nothing executes them. [bot-runtime/README.md](bot-runtime/README.md).
- **Single frontend bundle ~578 kB** (gzip ~173 kB), no code-splitting yet.

## License & author

Apache-2.0 — see [LICENSE](LICENSE). Author: Franz Mayer.

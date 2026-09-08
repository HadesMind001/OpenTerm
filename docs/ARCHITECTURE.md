# OpenTerm — Architecture

OpenTerm is a **local web-based market terminal**: a Python/FastAPI backend that
owns all data feeds, and a React frontend served by the same process (or an
Electron shell in dev). The browser holds a single WebSocket and subscribes to
the same topic strings the backend services use. There is **no
authentication and no multi-user story** — the trust model is one trusted
operator on one machine, plus an Origin guard against browser drive-bys
(see below and SECURITY.md).

```
providers ──▶ PartitionedEventBus (16 shards of topic pub/sub, bounded queues)
                  │
      ┌───────────┼────────────────────────────┐
      ▼           ▼                            ▼
MarketState  BarBuilder                    News buffers
(quotes/stats/depth)  (1m→1D aggregation, SQLite persistence)
      │                                        │
      └────────────────┬───────────────────────┘
                       ▼
         REST /api/*   ·   WS /ws (mirrors bus topics)
                               ▲
                    React workspace UI (browser / Electron)
```

## Layout

```
backend/openterm/
├── core/       bus.py (EventBus) · bus_partitioned.py (sharded facade)
│               events.py (dataclasses) · config.py (Settings + .env loader)
│               symbols.py · store.py (sync SQLite, WAL, user_version
│               migrations) · store_async.py (writer thread + read pool)
├── providers/  base.py (SDK: reconnect/backoff/capabilities/watched-set)
│               binance_ws.py · yahoo.py · gnews.py          (no key needed)
│               finnhub.py (profile/fundamentals/earnings)   (FINNHUB_API_KEY)
│               fred.py (macro series provider)              (FRED_API_KEY)
│               oanda.py (practice FX price stream)          (OANDA_TOKEN+ACCOUNT)
│               polygon.py (equity aggregates backfill)      (POLYGON_API_KEY)
│               alpaca.py (paper/live REST client)           (APCA_* keys)
├── services/   marketstate.py · bars.py (BarBuilder) · history.py
│               broker.py (paper engine: order types, slippage/commission,
│               positions, FIFO closed-trade matching, equity analytics)
│               screener.py · universe.py · correlation via routes/bars
│               alerts.py (10 rule kinds, cooldown, snooze, fire history)
│               sentiment.py (keyword lexicon) · options.py (Black-Scholes)
│               scripting.py (subprocess runner — NOT a sandbox)
│               bot_manager.py (EXPERIMENTAL: DB rows only, see below)
├── api/        app.py (FastAPI factory, SPA mount, LocalOriginGuard)
│               app_guard.py (origin rules) · routes.py (all REST)
│               bots.py · ws_gateway.py (bus → browser mirror)
│               ws_codec.py (binary framing, see below)
└── runtime.py  owns everything; 16 shard-dispatch loops; 30s equity sampler
frontend/src/
├── lib/        api.ts · ws.ts · codec.ts (mirrors ws_codec.py byte-for-byte)
│               indicators.ts (EMA/SMA/BB/VWAP/RSI/MACD/ATR/Stoch)
├── state/      valtio market store (per-bucket subscriptions) + zustand UI store
└── components/ CommandBar · WatchlistPanel · WorkspaceArea (pages:
                pulse/chart/screen/heatmap/research/alerts/blotter/analytics/
                journal/settings) · chart/ (lightweight-charts v5 + drawings)
                DepthPanel · TapePanel · PositionsRail · TicketModal · NewsRail
```

## Core

- **`events.py`** — dataclass models for every bus message: `Trade`, `Quote`,
  `Depth`, `Bar`, `StatsSnapshot`, `NewsItem`, `AlertEvent`, `FillEvent`,
  `ProviderStatus`. Each carries a `symbol_key` (`"CRYPTO:BTCUSDT"`,
  `"EQUITY:AAPL"`) and feed badge.
- **`bus.py`** — topic pub/sub with fnmatch wildcards (`tick:*`, `bar:*:1m`).
  Per-subscriber bounded queues drop the oldest event on overflow, so slow
  consumers never block publishers.
- **`bus_partitioned.py`** — a 16-shard facade over EventBus, sharded by
  symbol-prefix hash. Its own docstring is blunt about the value: the only
  real consumer (the WS gateway) subscribes `"*"`, which attaches to every
  shard — so sharding currently buys fan-in handles and future options, not
  throughput (publish is synchronous in-process). Do not scale features on
  top of it believing it parallelizes.
- **`symbols.py`** — resolves bare tickers (`BTC`), explicit pairs
  (`BTCUSDT`), and Bloomberg-ish suffixes (`TSLA US EQUITY`) into an
  `Instrument` with per-provider aliases (binance/yahoo/oanda names).
- **`store.py`** — sync sqlite3 behind one lock. Journal mode **WAL**,
  `busy_timeout=10 s` on every connection. Schema lives in one `_SCHEMA`
  script plus a **`PRAGMA user_version` migration ladder**
  (`_migrate_versioned`): v1 adds `bots.source` to databases that predate it.
  Every schema change after first release MUST come as a versioned step, not
  as wishful `CREATE TABLE IF NOT EXISTS` editing.
- **`store_async.py`** — `AsyncStore` is the runtime's single window into
  SQLite: one hot-path **writer thread** (batched, coalesced commits for
  closed bars + equity samples, bounded queue with loud fallback), a small
  pool of dedicated **read connections**, and the sync `Store` for
  correctness-critical writes (orders, fills, alerts), which go through
  immediately — accepting a documented ~1 ms blocking commit on the event
  loop instead of making the whole fill path async.

## Providers

Base class gives every adapter: reconnect with exponential backoff + jitter,
watched-symbol diffing/resubscription, and failure isolation (errors become
`ProviderStatus` events that drive the health dots). All provider tests are
offline — CI never hits a network API.

| Provider | Transport | Emits | Requires |
|---|---|---|---|
| `binance_ws.BinanceProvider` | WS combined streams + 24h REST poll | `Trade`, `Depth`, `StatsSnapshot` | — |
| `yahoo.YahooProvider` | REST chart API (poll) | prices, bars, day stats | — (unofficial scrape) |
| `gnews.GNewsProvider` | Google News RSS (poll) | `NewsItem` per symbol + market | — |
| `fred.FredProvider` | REST (poll) | macro series snapshot | `FRED_API_KEY` |
| `oanda.OandaProvider` | WS practice price stream | FX `Trade` ticks | `OANDA_TOKEN` + `OANDA_ACCOUNT_ID` |
| `finnhub.FinnhubClient` | REST (on demand) | profiles/fundamentals/earnings/chains | `FINNHUB_API_KEY` |
| `polygon.PolygonClient` | REST (on demand) | aggregate backfill | `POLYGON_API_KEY` |
| `alpaca.AlpacaClient` | REST (on demand) | live/paper orders + account | `APCA_API_KEY_ID` + secret |

OANDA note: `websockets>=14` renamed `connect(extra_headers=)` to
`additional_headers=` — pyproject pins `>=14` and `providers/oanda.py` uses
the new spelling; the old one raised TypeError silently inside the backoff
loop for a long time. OANDA is also wired into `Runtime.push_watched()` like
every other provider now (it used to be excluded by a hard-coded tuple and
streamed exactly nothing).

Missing keys/features degrade gracefully — dots go red/amber in the status bar.

## Runtime & dispatch

`Runtime` starts providers, loads the persisted watchlist into the watched
set, and runs **one dispatch loop task per bus shard** fanning events into
services: ticks → MarketState + BarBuilder + broker + alerts; closed bars →
store upsert; news → per-symbol deques; provider status → health map.

`push_watched()` coalesces watchlist churn into a single dirty-checked push
task and calls `set_watched` on **all** providers.

Key rotation (`POST /api/settings/keys`): changed key VALUES rebuild the
corresponding client/provider instances — old behavior only filled in `None`
slots, so a rotated key was silently ignored while the UI said "applied".

## Origin guard

CORS does not stop `<form>` POSTs or WebSockets from foreign pages — and this
API is unauthenticated by design. `LocalOriginGuard` (HTTP middleware) and
the WS handshake therefore reject any request carrying an `Origin` whose host
is not `localhost`/`127.0.0.1`/`::1`. Missing/empty origin (curl, native
clients) is allowed; `null` origin is not. This closes the browser drive-by
half of the hole; a local process still can do anything (SECURITY.md draws
that line explicitly).

## WS gateway & framing

The gateway sends a **hello** JSON text frame (snapshot + statuses + recent
news), then mirrors subscribed topics. Client commands (JSON, capped at
64 KB): `{"action":"sub", patterns}` / `sub_bot` / `ping` / `binary`.

Binary mode (`ws_codec.py`, mirrored byte-for-byte by
`frontend/src/lib/codec.ts` — change both in one commit):

```
byte 0       frame type (1 event, 2 pong, 3 compressed-event)
bytes 1..4   topic length, u32 BIG-endian (never negotiated; it is big-endian)
bytes 5..    topic (utf-8)
rest         msgpack payload; zstd'd iff payload > 1 KiB (type flips to 3)
```

hello is **always** JSON, even in binary mode. Decoding enforces a 64 KiB
topic cap and an 8 MiB decompressed-output cap (compression-bomb guard).
`pong` exists because browsers don't expose WS pings — the client must
heartbeat; dead sockets are reaped and unsubscribed (the old code leaked one
subscription per connection).

## Scripting trust model

`services/scripting.py` runs console code in a **subprocess as the server
user** with: `-I` isolated interpreter, env allowlist (PATH/HOME/… — provider
keys never inherited), `RLIMIT_CPU`/`RLIMIT_AS`/`RLIMIT_FSIZE`, wall-clock
timeout with process-group kill, and results carried through a private marker
file (stdout can no longer forge the protocol). It is hardening, **not
sandboxing**: a script can read anything your user can. The endpoint exists
because the operator IS the trust boundary — never expose the port.

## Bots (EXPERIMENTAL — reads like the README, this is the map)

`services/bot_manager.py` + `api/bots.py` persist bot registry rows
(`bots` table, `source` column) and honest log lines. **Nothing executes a
bot.** The intended future engine is the Rust workspace
(`bot-runtime/` + `bot-protocol/`): a wasmtime host with an `env.*` guest
ABI, Unix-socket JSON-lines transport, capability guardrails — and, as of
today, zero end-to-end execution (no working loader, order placement returns
UNSUPPORTED by design, app and runtime are not wired). Before touching any
of it read `bot-runtime/README.md`.

## Services

- **`MarketState`** — latest price/quote/day-stats/depth per symbol.
- **`BarBuilder`** — aggregates ticks into 1m/5m/15m/1h/4h/1d buckets
  (4h buckets floor to epoch-aligned boundaries); publishes partial bars each
  tick and closed bars at boundaries; in-progress buckets survive restarts by
  seeding from the last persisted row.
- **`HistoryService`** — serves chart data: store first, then REST backfill
  (Binance klines for crypto, Yahoo chart for equities, Polygon when keyed),
  merged and persisted.
- **`alerts.py`** — ten kinds: `above below pct_up pct_dn rsi_above rsi_below
  vol_spike trailing_stop time_above time_below`. For `time_*` the
  `cooldown` field doubles as the hold-seconds duration (documented
  overload; no schema column for it yet) and hold-timers are keyed per rule.
- **`screener.py` / `universe.py`** — static default universe + movers;
  Pearson correlation computed from persisted bars (`/correlation*` routes).

## Frontend

React 19. The market side uses **valtio** with per-bucket subscriptions
(a tick updates one proxy bucket, not one 40-field store snapshot —
zustand-only caused full re-renders every tick); UI state remains zustand.
WS frames decode through `lib/codec.ts` into typed handlers; reconnect does a
real teardown + resubscribe and sends `ping` for keepalive. Charts use
lightweight-charts v5; the treemap heatmap is a squarified implementation in
`lib/squarify.ts`.

## Run

```bash
make dev      # backend :8000 + Vite :5173 + Electron
make serve    # single process on :8765 serving built SPA + API
make test     # pytest (147 tests)
make test-frontend
```

See [docs/COMMANDS.md](COMMANDS.md) for the command-line reference.

## Optional data keys

`.env.example` lists every variable; copy to `.env` or use Settings → Keys.
The config file defaults to `~/.config/openterm/config.json` (atomic write,
mode 0600); override the location with `OT_CONFIG_PATH`. Env vars win over
the file. Availability shows on Market Pulse / `/api/settings` (booleans
only — key values never leave the config file over the API).

## Paper trading

The broker starts with a $100k seed deposit. B/S buttons open the ticket
modal; market orders fill on the next tick with configurable slippage
(2 bps) and commission (5 bps). Fills publish `fill:*` events that drive
UI toasts. Working GTC orders and all positions/cash survive restarts —
cash is **derived** from the fills ledger, never stored, so a crash between
fill-insert and order-update self-heals. The analytics page computes the
equity curve (30s samples), drawdown series, Sharpe (labeled honestly: it is
a daily-convention number computed from 30s samples — see broker.py
commentary), win rate, profit factor, and FIFO-matched closed trades.
Positions never short: a second sell cancels instead of flipping.

# OpenTerm — Command Reference

Focus the command line with `Ctrl+K` (or `/` when not typing in a field).
`Esc` clears. Commands are case-insensitive; symbols accept bare tickers
(`AAPL`), aliases (`APPLE`, `TESLA`, `BITCOIN`), crypto auto-pairing
(`BTC` → `BTCUSDT`) and Bloomberg-ish suffixes (`TSLA US`, `AAPL EQUITY`).

## Page & symbol verbs

| Command | Action |
|---|---|
| `AAPL` | resolve + add to watchlist + open chart |
| `BTC` / `SOLUSDT` | crypto majors auto-pair to USDT |
| `AAPL GP` | open chart view for the symbol |
| `AAPL DES` / `HP AAPL` | research page: 52w range, peers, journal, sentiment news |
| `AAPL NEWS` / `NEWS AAPL` | same, sentiment-tagged headlines focus |
| `AAPL TAPE` / `AAPL BOOK` | chart with tape / depth book focused |
| `ALERT AAPL above 200` | arm a price alert straight from the command line |
| `ALERT` / `ALERTS` | alerts builder + fire history |
| `SCREEN` | screener, movers, correlation, normalized compare |
| `HEAT` / `HEATMAP` | market heatmap (squarified treemap) |
| `PORTF` | portfolio analytics (equity curve, Sharpe, drawdown) |
| `BLT` | order blotter (cancel/amend working orders) |
| `JOUR` | trade journal |
| `SETTINGS` | keybindings, workspaces, provider keys, scripts console |
| `HELP` or `?` | in-app cheat sheet |

## Alert kinds (all ten)

Create via the Alerts page, `ALERT <SYM> <kind> <value>`, or
`POST /api/alerts {symbol_key, kind, threshold, one_shot?, cooldown?, note?}`.

| Kind | Fires when | Threshold is | In UI |
|---|---|---|---|
| `above` | price ≥ threshold | absolute price | ✔ |
| `below` | price ≤ threshold | absolute price | ✔ |
| `pct_up` | rise ≥ threshold% from arming price | percent | ✔ |
| `pct_dn` | fall ≥ threshold% from arming price | percent | ✔ |
| `rsi_above` | 1m RSI ≥ threshold | RSI value | ✔ |
| `rsi_below` | 1m RSI ≤ threshold | RSI value | ✔ |
| `vol_spike` | closed 1m volume ≥ N× rolling avg | multiplier | ✔ |
| `trailing_stop` | price retreats N% from session high (buy ticks) or advance N% below low (sell ticks) | percent | API-only |
| `time_above` | price **stays ≥** threshold continuously | absolute price | API-only |
| `time_below` | price **stays ≤** threshold continuously | absolute price | API-only |

### The `cooldown` field does two jobs — read carefully

- Normal kinds: `cooldown` seconds = minimum **spacing between fires** of a
  recurring rule (default 300).
- `time_above` / `time_below`: `cooldown` is reinterpreted as the **hold
  duration** — "price must stay on this side for `cooldown` **seconds**".
  A `time_above 3000` with cooldown 42 means "above $3000 continuously for
  42 s" (yes, this is an overload of the field, deliberately documented in
  `services/alerts.py` until the schema gets a real `duration` column).

Hold-timers are tracked **per rule**, so a `time_above 100` and a
`time_below 90` on the same symbol never clobber each other.

## Lifecycle: one-shot, cooldown, snooze, toggle

- **one-shot** (default): deactivates after firing; **recurring** rules stay
  armed but honor `cooldown` spacing.
- **Snooze**: suppresses firing until a wall-clock deadline. The UI snoozes
  30 min; the API takes any `seconds` 1–86 400 (`POST /api/alerts/{id}/snooze
  {"seconds": 900}`).
- **Toggle**: `POST /api/alerts/{id}/toggle {"active": true|false}` — off
  keeps the rule (and its fire history) and can be re-armed any time, even
  after it left memory.

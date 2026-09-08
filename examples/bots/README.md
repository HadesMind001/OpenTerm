# Example bots

> **STATUS — read first.** The Bots feature is **EXPERIMENTAL and executes
> nothing.** Deploying a bot stores a registry row and log lines in SQLite;
> no engine runs this source — the intended WASM runtime
> (`bot-runtime/`, see its README) is scaffolding that does not yet launch
> bots end-to-end. These files are useful today as *documentation of the
> intended API shape*, not as running software.

Three small, self-contained strategy bots in the OpenTerm Python API
(`on_start` / `on_bar` with the `ctx` host facade: market data, orders,
positions, signals, logging, key-value state).

## Docstring format is a PARSE CONTRACT, not prose

The Bots page lists each example by running `ast.get_docstring` over the
source (`bot_manager.py::_parse_example_meta`): the **first non-empty
docstring line is the title**, and it is split on an **em dash (`—`)** into
`Name — description`; without an em dash, the second non-empty line becomes
the description. Reword freely, but keep the first-line shape — a bot that
loses its `Title — blurb` line silently renders as a nameless row (or worse,
shows "SMA Crossover — golden/death…" as the name of something else) in the
deploy dialog.

| File | Style | Idea |
|---|---|---|
| `sma_crossover.py` | trend | Buy golden cross (fast SMA > slow SMA), sell death cross |
| `rsi_mean_reversion.py` | counter-trend | Buy RSI < 30, exit on recovery above 55 |
| `donchian_breakout.py` | momentum | Buy new 20-bar high, exit on 10-bar low or 3% stop; persists state across restarts |

## Deploy

Open the **Bots** page → **Deploy** → *Load file* (or paste the source),
pick a risk profile, and start the bot. Every parameter is editable
afterwards in the bot's **Config** panel (Save & Restart applies live).

Each file lists its config keys in the module docstring. Defaults are
Alpaca paper symbols (`EQUITY:AAPL`, `EQUITY:SPY`, `EQUITY:QQQ`); set
`symbol` to any key in your watchlist to retarget a bot.

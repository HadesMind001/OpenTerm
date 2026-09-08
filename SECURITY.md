# Security Policy

## The trust model, stated honestly

OpenTerm is **local-first, single-user, unauthenticated by design**. The
threat model is: one trusted operator on one machine, plus hostile *web pages*
that try to drive-by-mutate the local app. It is NOT: multi-tenant, shared
server, or untrusted-local-users.

- The server binds `127.0.0.1` by default. There is **no auth**; if you pass
  `--host 0.0.0.0` (the CLI warns loudly), everything below becomes your
  LAN's problem.
- **Browser drive-bys** are blocked by an Origin guard (`api/app_guard.py`):
  HTTP requests and the WS handshake carrying a foreign `Origin` get 403.
  No/empty Origin (curl, native tools) is allowed — the guard targets
  cross-site *browsers*, not local processes. A local process is inside the
  trust boundary already.

## What is hardened, and where the line actually is

| Surface | Hardening | Remaining risk |
|---|---|---|
| Provider keys | config file written atomically with mode `0600`; env-var scrubbing for subprocesses; API error strings redacted so provider URLs (which carry keys as query params) never reach HTTP responses; `GET /api/settings` exposes booleans only | a key leaked in a provider URL can still land in *server* logs (`exc_info` traces) — rotate on suspicion |
| Scripts console | subprocess with `-I` isolated interpreter, env allowlist, RLIMIT_CPU/AS/FSIZE, wall-clock timeout + process-group kill, marker-file result protocol (stdout cannot forge it) | **NOT a sandbox.** Code runs as your user and can read anything you can. Anyone who can reach `/api/scripts/run` can run code as you |
| Bot runtime socket (experimental) | Unix socket created `0600`; refuses to unlink non-socket files at bind; 1 MiB inbound line cap; unimplemented methods answer with honest UNSUPPORTED errors | socket is unauthenticated — anyone with file access can talk to it (harmless today because it does nothing; NOT harmless once order routing lands — auth is roadmap item 5 in bot-runtime/README.md) |
| WS gateway | binary decode caps (64 KiB topic, 8 MiB decompressed output), JSON command size cap, per-connection subscription cleanup, dead-socket reap | no auth (same localhost assumption) |
| Order/account endpoints | paper engine only; sells cannot go short; market orders without a price are rejected *before* any DB write (no ghost orders) | OANDA/Alpaca keys, if configured, enable real venue calls by design |

## If your API keys may have leaked

1. Revoke/rotate at the provider (Finnhub, FRED, Polygon, OANDA, Alpaca).
2. Save the new keys via Settings → Keys (or the config file) — `apply_settings`
   now actually rebuilds clients on key VALUE changes; old values are not kept
   alive by a restart you didn't do.
3. If you ever ran scripts from untrusted snippets in older versions, assume
   whatever your user could read was readable.

## Known issues we are aware of (not bugs to report first)

- Money is float (paper-only; documented), `tif="day"` is not auto-cancelled,
  `time_above/below` overload the `cooldown` column as hold-seconds pending
  an alerts-schema migration, the bot registry stores rows that nothing
  executes, the Rust runtime is EXPERIMENTAL scaffolding.
- Code-documented engineering debt, tracked here so it is not "discovered"
  as a security finding: the three broker writes per fill (fill row, cash
  math, order status) are not one SQLite transaction yet — the ordering is
  crash-safe (ledger stays right, status may lag); fills are always full
  size (partial-fill plumbing exists in the math but nothing produces it);
  AsyncStore keeps a small fixed pool of thread-shared read connections
  rather than thread-local ones; the runtime KV table namespaces by key
  prefix (LIKE + ESCAPE) not a real column, so one bot *could* read another
  bot's keys the day per-bot state ships; the Rust loader's Cargo.toml
  `package_name` parser is line-based and simple on purpose (it only ever
  runs on source you already trust — see the RCE note above).
- Yahoo and Google News RSS access is **unofficial scraping** — ToS-gray and
  breakable upstream at any time.

## Reporting a vulnerability

Open a **private security advisory** on the repository (GitHub → Security →
Report a vulnerability). Do not file a public issue for anything that turns
the local trust model into a remote exploit. Expect a response as fast as an
unpaid hobby project can manage; fixes land with regression tests, because in
this repo a security fix without a test is a security fix that will rot.

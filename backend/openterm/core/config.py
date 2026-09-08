from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "openterm" / "config.json"

# Repo-root .env, discovered relative to this file (backend/openterm/core/ -> repo root).
_DEFAULT_ENV_FILE = Path(__file__).resolve().parents[3] / ".env"


def _load_env_file() -> None:
    """Parse a minimal KEY=VALUE .env into os.environ (existing vars win).

    Deliberately dependency-free and boring: no interpolation, no shell quoting,
    no `export` keyword. Real env variables always take precedence so container
    deploys are never surprised by a stray .env lying around.
    """
    path = Path(os.environ.get("OPENTERM_ENV_FILE", str(_DEFAULT_ENV_FILE)))
    try:
        raw = path.read_text()
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # Strip matching quotes if the user wrapped values in them.
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass
class Settings:
    finnhub_key: str = ""
    fred_key: str = ""
    oanda_token: str = ""
    oanda_account: str = ""
    polygon_key: str = ""
    alpaca_key_id: str = ""
    alpaca_secret_key: str = ""

    def availability(self) -> dict[str, bool]:
        return {
            "finnhub": bool(self.finnhub_key),
            "fred": bool(self.fred_key),
            "oanda": bool(self.oanda_token and self.oanda_account),
            "polygon": bool(self.polygon_key),
            "alpaca": bool(self.alpaca_key_id and self.alpaca_secret_key),
        }

    # NOTE: never add __repr__ that shows field values — Settings holds live
    # provider API keys and a stray traceback print would leak them to logs.


def config_path() -> Path:
    custom = os.environ.get("OT_CONFIG_PATH")
    if custom:
        return Path(custom)
    return CONFIG_PATH


def load_settings(path: str | Path | None = None) -> Settings:
    _load_env_file()
    p = Path(path) if path else config_path()
    data: dict[str, str] = {}
    try:
        data = json.loads(p.read_text())
    except Exception:
        # Missing/corrupt config file is normal on first boot — env (and .env)
        # still get their chance below. Swallowing here is intentional.
        pass

    def pick(json_key: str, *env_names: str) -> str:
        # Env wins over the config file so deploys can override without edits.
        for env in env_names:
            val = os.environ.get(env)
            if val:
                return val
        return str(data.get(json_key, "") or "")

    return Settings(
        finnhub_key=pick("finnhub_key", "FINNHUB_API_KEY"),
        fred_key=pick("fred_key", "FRED_API_KEY"),
        oanda_token=pick("oanda_token", "OANDA_TOKEN"),
        oanda_account=pick("oanda_account", "OANDA_ACCOUNT_ID"),
        polygon_key=pick("polygon_key", "POLYGON_API_KEY"),
        alpaca_key_id=pick("alpaca_key_id", "APCA_API_KEY_ID"),
        alpaca_secret_key=pick("alpaca_secret_key", "APCA_API_SECRET_KEY"),
    )

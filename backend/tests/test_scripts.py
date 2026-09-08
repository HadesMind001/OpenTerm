"""Regression tests for the scripts console (services/scripting.py + routes).

scripting.py was rewritten from a fake "AST-sanitized exec" (which never ran
anything — two NameErrors) to a real resource-limited subprocess. These pin
the properties the rewrite promised:

  * output and variables arrive through a MARKER FILE, not stdout — a script
    that prints protocol-shaped JSON must not be able to forge a result;
  * the child env is scrubbed: provider keys must never reach script code;
  * wall-clock timeout actually kills;
  * the /scripts/close and symbols parameters are honest no-ops, not errors.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from openterm.api.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OT_CONFIG_PATH", str(tmp_path / "cfg" / "config.json"))
    # Make a canary secret visible to the parent — if the child env were the
    # inherited one (the old behaviour), it would surface in the script output.
    monkeypatch.setenv("FINNHUB_API_KEY", "CANARY-LEAK-CHECK")
    app = create_app(db_path=tmp_path / "t.db", with_providers=False)
    with TestClient(app) as c:
        yield c


def _run(client, code, **extra):
    r = client.post("/api/scripts/run", json={"code": code, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_happy_path_print_and_vars(client):
    out = _run(client, "print('hi from script')\nx = 41 + 1\n")
    assert out["success"] is True, out
    assert "hi from script" in out["output"]
    assert "42" in out["variables"].get("x", "")


def test_scrubbed_env_hides_provider_keys(client):
    out = _run(client, "import os\nprint(sorted(os.environ))\n")
    assert out["success"] is True
    assert "FINNHUB_API_KEY" not in out["output"]
    assert "CANARY-LEAK-CHECK" not in out["output"]
    # PATH is allowlisted, so the child can still run at all
    assert "PATH" in out["output"]


def test_stdout_cannot_forge_the_result_protocol(client):
    """Old design smuggled the result through stdout's tail — any script
    printing valid protocol JSON forged it. The result now comes from a
    private marker file only."""
    out = _run(client, "import json\n"
                       "print(json.dumps({'success': False, 'error': 'FORGED',"
                       " 'variables': {'FORGED': 'yes'}}))\n")
    assert out["success"] is True  # the script itself succeeded
    assert "FORGED" not in str(out["variables"])
    assert out["error"] == ""


def test_forged_result_file_is_overwritten_by_runner(client):
    """The runner rewrites the result path after user code returns, so
    scribbling on sys.argv[2] from the script achieves nothing."""
    out = _run(client, "import sys\n"
                       "open(sys.argv[2], 'w').write('{\"success\": true, \"variables\": {\"FORGED\": 1}}')\n"
                       "real = 1\n")
    assert out["success"] is True, out
    assert "FORGED" not in str(out["variables"])
    assert "real" in out["variables"]


def test_timeout_kills_runaway(client):
    # while True: pass pegs CPU; RLIMIT_CPU is the backstop, wall-clock the
    # primary. Either way the request must come BACK, not hang forever.
    out = _run(client, "while True:\n    pass\n")
    assert out["success"] is False
    assert out["exit_code"] != 0
    assert "killed" in out["error"].lower() or "died" in out["error"].lower()


def test_syntax_error_reported_not_swallowed(client):
    out = _run(client, "def broken(:\n")
    assert out["success"] is False
    assert out["error"] or out["output"]


def test_symbols_param_tolerated_and_close_is_noop(client):
    out = _run(client, "print(1)", symbols="AAPL,BTCUSDT")
    assert out["success"] is True and "1" in out["output"]
    r = client.post("/api/scripts/close")
    assert r.status_code == 200 and r.json() == {"ok": True}

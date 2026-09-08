"""AlertEngine regressions.

  * toggle(off) used to POP the rule from engine.rules — toggling back on
    looked up a dict that no longer held it and 404'd until restart. Now the
    rule stays with active=False, and even genuinely-evicted rules (fired
    one-shots) are re-loaded from the store.
  * time_above/time_below compared elapsed against `threshold` — the PRICE
    as a DURATION ("$3000 for 42s" meant 3000 seconds). The hold time is the
    `cooldown` field for these kinds (pragmatic overload, documented in the
    service + docs/COMMANDS.md).
  * The hold timer was keyed by SYMBOL, so two time_* rules on one symbol
    reset each other. Keyed by rule id now.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest

from openterm.core.bus import EventBus
from openterm.core.events import Trade
from openterm.core.store import Store
from openterm.services.alerts import AlertEngine

KEY = "EQUITY:AAPL"


def tick(px: float) -> Trade:
    return Trade(symbol_key=KEY, price=px, ts=datetime.now(timezone.utc))


@pytest.fixture()
def env(tmp_path):
    store = Store(tmp_path / "a.db")
    return store, AlertEngine(EventBus(), store)


def fires(store: Store, alert_id: int) -> list[dict]:
    return [f for f in store.alert_fires() if f["alert_id"] == alert_id]


def test_toggle_off_then_on_survives(env):
    _store, engine = env
    rule = engine.create(KEY, "above", 100.0, None, one_shot=False, cooldown=0)
    assert engine.toggle(rule["id"], False) is True
    # the old bug: rule vanished from memory -> toggle(True) returned False
    assert engine.toggle(rule["id"], True) is True
    assert engine.rules[rule["id"]]["active"] is True
    engine.on_trade(tick(101.0))
    assert fires(_store, rule["id"])


def test_toggle_reloads_evicted_rule_from_store(env):
    store, engine = env
    rule = engine.create(KEY, "above", 100.0, None, one_shot=False, cooldown=0)
    engine.toggle(rule["id"], False)
    engine.rules.pop(rule["id"])  # simulate eviction (fired one-shot, restart)
    assert engine.toggle(rule["id"], True) is True, "store reload branch broken"
    engine.on_trade(tick(999.0))
    assert fires(store, rule["id"])
    assert engine.toggle(rule["id"], False) is True
    # nonexistent id stays honest
    assert engine.toggle(4242, True) is False


def test_time_above_fires_after_hold_seconds(env):
    store, engine = env
    rule = engine.create(KEY, "time_above", 100.0, None,
                         one_shot=False, cooldown=1)  # hold 1 second
    engine.on_trade(tick(110.0))
    assert not fires(store, rule["id"]), "must NOT fire on first touch"
    time.sleep(1.05)
    engine.on_trade(tick(110.0))
    assert fires(store, rule["id"]), "hold condition (cooldown secs) not honored"


def test_time_above_resets_when_price_leaves(env):
    store, engine = env
    rule = engine.create(KEY, "time_above", 100.0, None,
                         one_shot=False, cooldown=1)
    engine.on_trade(tick(110.0))
    time.sleep(0.6)
    engine.on_trade(tick(90.0))          # drops below -> timer resets
    time.sleep(0.6)
    engine.on_trade(tick(110.0))         # total elapsed >1s, but per-rule...
    assert not fires(store, rule["id"]), "timer did not reset across a cross"


def test_time_rules_are_independent_per_rule(env):
    store, engine = env
    hot = engine.create(KEY, "time_above", 100.0, None, one_shot=False, cooldown=1)
    cold = engine.create(KEY, "time_above", 5000.0, None, one_shot=False, cooldown=1)
    engine.on_trade(tick(110.0))  # hot starts holding; cold resets (per-id)
    time.sleep(1.05)
    engine.on_trade(tick(110.0))
    assert fires(store, hot["id"]), "cold rule's reset clobbered hot's timer"
    assert not fires(store, cold["id"])

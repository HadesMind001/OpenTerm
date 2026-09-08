from __future__ import annotations

import time
from collections import deque
from typing import Any

from ..core.bus import EventBus
from ..core.events import AlertEvent, Bar, Trade
from ..core.store import Store

KINDS = {
    "above",
    "below",
    "pct_up",
    "pct_dn",
    "rsi_above",
    "rsi_below",
    "vol_spike",
    "trailing_stop",
    "time_above",
    "time_below",
}
RSI_PERIOD = 14


def rsi_series(closes: list[float], period: int = RSI_PERIOD) -> float | None:
    if len(closes) <= period:
        return None
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    gain /= period
    loss /= period
    out: float | None = 100.0 if loss == 0 else 100.0 - 100.0 / (1 + gain / loss)
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (period - 1) + max(d, 0)) / period
        loss = (loss * (period - 1) + max(-d, 0)) / period
        out = 100.0 if loss == 0 else 100.0 - 100.0 / (1 + gain / loss)
    return out


class AlertEngine:
    """Evaluates alert rules against live ticks and closed bars.

    Kinds: above | below | pct_up | pct_dn | rsi_above | rsi_below |
    vol_spike | trailing_stop | time_above | time_below.
    (The UI only exposes the first seven; the trailing/time kinds are API-only
    and their semantics are documented in docs/COMMANDS.md.)

    Fires publish AlertEvent on `alert:{id}`; history persists; one-shot rules
    deactivate after firing, recurring ones honor a cooldown and snooze window.

    Rules are evaluated inline in the event dispatch path — keep this cheap
    and NEVER block here: every tick of every symbol runs this loop.
    """

    def __init__(self, bus: EventBus, store: Store) -> None:
        self.bus = bus
        self.store = store
        self.rules: dict[int, dict[str, Any]] = {}
        self.closes: dict[str, deque[float]] = {}
        self.vols: dict[str, deque[float]] = {}
        self._trailing_highs: dict[str, float] = {}
        self._trailing_lows: dict[str, float] = {}
        # rule_id -> wall-clock ts when the rule's side-condition began holding
        self._cross_since: dict[int, float | None] = {}
        for row in store.alerts(active_only=True):
            self.rules[row["id"]] = row

    def create(
        self,
        symbol_key: str,
        kind: str,
        threshold: float,
        ref_price: float | None,
        one_shot: bool = True,
        cooldown: int = 300,
        note: str = "",
    ) -> dict:
        if kind not in KINDS:
            raise ValueError(f"unknown alert kind '{kind}'")
        if threshold <= 0 and kind != "below":
            raise ValueError("threshold must be > 0")
        row = {
            "symbol_key": symbol_key,
            "kind": kind,
            "threshold": float(threshold),
            "ref_price": ref_price,
            "active": True,
            "one_shot": one_shot,
            "cooldown": max(0, int(cooldown)),
            "note": note,
        }
        aid = self.store.insert_alert(row)
        row["id"] = aid
        row["snooze_until"] = 0.0
        row["last_fired"] = None
        self.rules[aid] = row
        return row

    def remove(self, alert_id: int) -> bool:
        self.rules.pop(alert_id, None)
        return self.store.remove_alert(alert_id)

    def snooze(self, alert_id: int, seconds: int) -> bool:
        rule = self.rules.get(alert_id)
        if not rule:
            return False
        until = time.time() + max(0, seconds)
        rule["snooze_until"] = until
        self.store.update_alert(alert_id, snooze_until=until)
        return True

    def toggle(self, alert_id: int, active: bool) -> bool:
        """Activate/deactivate a rule.

        The old version POPPED the rule from self.rules on deactivate — so
        "turn it back on" looked up a dict that no longer contained it and
        returned 404 forever (until restart, which reloaded from the DB).
        Deactivated rules now stay in memory with active=False; the eval loops
        already skip inactive rules.
        """
        rule = self.rules.get(alert_id)
        if rule is None:
            # Could be a one-shot that already fired (popped in _fire), or a
            # rule deactivated before this fix. Re-load from the store, else
            # report honestly that it does not exist.
            row = next(
                (r for r in self.store.alerts() if r["id"] == alert_id), None
            )
            if row is None:
                return False
            row.setdefault("snooze_until", 0.0)
            row.setdefault("last_fired", None)
            self.rules[alert_id] = row
            rule = row
        rule["active"] = active
        self.store.update_alert(alert_id, active=int(active))
        return True

    def on_trade(self, ev: Trade) -> None:
        px = float(ev.price)
        side = ev.side  # "buy" | "sell" | None
        for rule in list(self.rules.values()):
            if rule["symbol_key"] != ev.symbol_key or not rule["active"]:
                continue
            kind = rule["kind"]
            hit = False
            if kind == "above":
                hit = px >= rule["threshold"]
            elif kind == "below":
                hit = px <= rule["threshold"]
            elif kind == "pct_up" and rule.get("ref_price"):
                hit = px >= rule["ref_price"] * (1 + rule["threshold"] / 100)
            elif kind == "pct_dn" and rule.get("ref_price"):
                hit = px <= rule["ref_price"] * (1 - rule["threshold"] / 100)
            elif kind == "trailing_stop":
                # Trailing stop: trail by percentage from highest/lowest price
                symbol_key = rule["symbol_key"]
                if side == "buy":
                    if symbol_key not in self._trailing_highs:
                        self._trailing_highs[symbol_key] = px
                    self._trailing_highs[symbol_key] = max(self._trailing_highs[symbol_key], px)
                    trailing_px = self._trailing_highs[symbol_key] * (1 - rule["threshold"] / 100)
                    hit = px <= trailing_px
                elif side == "sell":
                    if symbol_key not in self._trailing_lows:
                        self._trailing_lows[symbol_key] = px
                    self._trailing_lows[symbol_key] = min(self._trailing_lows[symbol_key], px)
                    trailing_px = self._trailing_lows[symbol_key] * (1 + rule["threshold"] / 100)
                    hit = px >= trailing_px
            elif kind in ("time_above", "time_below"):
                # "Price must stay on one side of `threshold` for N seconds".
                #
                # Two historical foot-guns, both fixed here:
                #   1. The old code compared `elapsed >= rule["threshold"]`,
                #      i.e. it used the PRICE LEVEL as the DURATION. A "$3000
                #      for 42s" alert is... $3000 for $3000 seconds (~50 min).
                #      The hold duration is the `cooldown` field for these
                #      kinds (see note below).
                #   2. State was keyed by symbol, so two time_* rules on one
                #      symbol (e.g. time_above 100 and time_below 90) reset
                #      each other's timers. Keyed by rule id now.
                #
                # NOTE: semantically abusing `cooldown` as "hold seconds" for
                # these kinds instead of adding a DB column is a pragmatic
                # call: the alerts table has no `duration` column, the schema
                # has no migration story yet, and these two kinds are not
                # exposed in the UI. When you add alert migrations, split the
                # field properly.
                held = self._cross_since.setdefault(rule["id"], None)
                above = px >= rule["threshold"]
                on_side = above if kind == "time_above" else not above
                if not on_side:
                    self._cross_since[rule["id"]] = None
                elif held is None:
                    self._cross_since[rule["id"]] = time.time()
                elif time.time() - held >= rule.get("cooldown", 300):
                    hit = True
                    # Reset so it doesn't re-fire until price crosses back.
                    self._cross_since[rule["id"]] = None
            if hit:
                self._fire(rule, px)

    def on_bar(self, ev: Bar) -> None:
        if ev.interval != "1m" or not ev.closed:
            return
        key = ev.symbol_key
        closes = self.closes.setdefault(key, deque(maxlen=200))
        vols = self.vols.setdefault(key, deque(maxlen=200))
        closes.append(ev.c)
        vols.append(ev.v)
        rsi = rsi_series(list(closes))
        avg_vol = (
            sum(list(vols)[:-1]) / (len(vols) - 1) if len(vols) > 5 else None
        )
        for rule in list(self.rules.values()):
            if rule["symbol_key"] != key or not rule["active"]:
                continue
            kind = rule["kind"]
            hit = False
            detail = ""
            if kind in ("rsi_above", "rsi_below") and rsi is not None:
                if kind == "rsi_above":
                    hit = rsi >= rule["threshold"]
                else:
                    hit = rsi <= rule["threshold"]
                detail = f"RSI {rsi:.1f}"
            elif kind == "vol_spike" and avg_vol:
                mult = ev.v / avg_vol if avg_vol else 0
                if mult >= rule["threshold"]:
                    hit = True
                    detail = f"{mult:.1f}x avg vol"
            if hit:
                self._fire(rule, ev.c, detail)

    def _fire(self, rule: dict, price: float, detail: str = "") -> None:
        now = time.time()
        if rule.get("snooze_until", 0) > now:
            return
        last = rule.get("last_fired")
        if last and now - last < rule.get("cooldown", 300):
            return
        rule["last_fired"] = now
        self.store.record_fire(rule["id"], price)
        msg = f"{rule['symbol_key'].split(':')[-1]} {rule['kind']} {rule['threshold']:g}"
        if detail:
            msg += f" ({detail})"
        self.bus.publish(
            f"alert:{rule['id']}",
            AlertEvent(
                symbol_key=rule["symbol_key"],
                feed="ALERT",
                alert_id=rule["id"],
                kind=rule["kind"],
                price=price,
                message=msg,
            ),
        )
        if rule.get("one_shot", True):
            rule["active"] = False
            self.store.update_alert(rule["id"], active=0)
            self.rules.pop(rule["id"], None)

    def all_rules(self) -> list[dict]:
        return list(self.store.alerts())

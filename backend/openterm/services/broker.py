from __future__ import annotations

import time
from typing import Any, Optional

from ..core.bus import EventBus
from ..core.events import FillEvent, Trade
from ..core.store import Store
from .marketstate import MarketState

ORDER_TYPES = {"market", "limit", "stop", "stop_limit"}
SIDES = {"buy", "sell"}


class OrderError(ValueError):
    pass


class Broker:
    """Paper-trading engine: market/limit/stop/stop_limit orders with
    slippage + commission, cash ledger, weighted-average positions.

    State is rebuilt on boot from fills + cash ledger; working GTC orders
    survive restarts. Every fill publishes a FillEvent on the bus.

    MONEY IS FLOATS. Deliberate: this is a paper engine with toy money;
    Decimal end-to-end would touch the store schema, every route and the whole
    frontend for zero real-world benefit here. The 1e-9 epsilons you see
    scattered around are the honest admission that qty/cash are binary floats
    being compared after arithmetic. If you ever point this at real money:
    don't — use the Alpaca venue instead.

    `tif` is stored but only "gtc" has real behavior: "day" orders are NOT
    auto-cancelled at a session boundary because paper trading has no
    trustworthy concept of one across timezones/vacations. Documented in
    docs/ARCHITECTURE.md as a known simplification.
    """

    def __init__(
        self,
        bus: EventBus,
        store: Store,
        market: MarketState,
        starting_cash: float = 100_000.0,
        slippage_bps: float = 2.0,
        commission_bps: float = 5.0,
    ) -> None:
        self.bus = bus
        self.store = store
        self.market = market
        # The old signature accepted starting_cash and then seeded a hardcoded
        # 100k anyway. Parameter now respected on fresh accounts.
        self.starting_cash = starting_cash
        self.slippage_bps = slippage_bps
        self.commission_bps = commission_bps
        self.orders: dict[int, dict[str, Any]] = {}
        self.positions: dict[str, dict[str, float]] = {}
        self._load()

    def _load(self) -> None:
        deposits, fills = self.store.cash_flows()
        if deposits == 0 and not fills:
            # Fresh account: seed initial capital exactly once. From then on
            # cash is *derived* (deposits - net fill deltas), never stored —
            # which is what makes the ledger self-healing after a crash
            # between a fill insert and an order update.
            self.store.add_cash(self.starting_cash, "initial deposit")
            deposits = self.starting_cash
        self.cash = deposits
        for f in fills:
            self._apply_fill_math(f["symbol_key"], f["side"], f["qty"], f["price"], f["fee"])
            self.cash -= self._cash_delta(f["side"], f["qty"], f["price"], f["fee"])
        for row in self.store.get_orders(status="working"):
            self.orders[row["id"]] = row
        self._flatten_shorts()

    def _flatten_shorts(self) -> None:
        """Legacy-data guard: close out negative (shorted) positions so equity
        stays meaningful. Paper accounts never short by design."""
        for key, pos in self.positions.items():
            if pos["qty"] < -1e-9:
                pos["qty"] = 0.0

    def _load_cash_only(self) -> None:
        deposits, fills = self.store.cash_flows()
        self.cash = deposits
        for f in fills:
            self.cash -= self._cash_delta(
                f["side"], f["qty"], f["price"], f["fee"]
            )

    @staticmethod
    def _cash_delta(side: str, qty: float, price: float, fee: float) -> float:
        # Sign convention: this is money LEAVING the account. A buy pays
        # notional + fee; a sell receives notional - fee, hence the outer
        # minus. Fee is a cost on BOTH sides — there is no side of the trade
        # where the venue pays you for the privilege.
        return (qty * price + fee) if side == "buy" else -(qty * price - fee)

    def submit(
        self,
        symbol_key: str,
        side: str,
        otype: str,
        qty: float,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        tif: str = "gtc",
    ) -> dict:
        if side not in SIDES:
            raise OrderError("side must be buy|sell")
        if otype not in ORDER_TYPES:
            raise OrderError("unknown order type")
        if qty <= 0:
            raise OrderError("qty must be > 0")
        if otype in ("limit", "stop_limit") and not limit_price:
            raise OrderError("limit price required")
        if otype in ("stop", "stop_limit") and not stop_price:
            raise OrderError("stop price required")
        if side == "sell":
            held = self.positions.get(symbol_key, {}).get("qty", 0)
            if qty > held + 1e-9:
                raise OrderError(
                    f"insufficient position: hold {held}, sell {qty}"
                )
        # Market orders need a price NOW. The old code inserted the order row
        # first and raised afterwards, leaving a "working" market order in the
        # DB that _evaluate never touches (it only handles limit/stop kinds) —
        # a ghost that haunted the blotter until death. Validate before any
        # side effects.
        if otype == "market":
            last = self.market.get(symbol_key, {}) or {}
            if last.get("last") is None:
                raise OrderError("no market price yet — cannot fill")
        row = {
            "symbol_key": symbol_key,
            "side": side,
            "otype": otype,
            "qty": float(qty),
            "limit_price": limit_price,
            "stop_price": stop_price,
            "tif": tif,
            "status": "working",
            "filled_qty": 0.0,
            "avg_fill": None,
            "created": time.time(),
        }
        oid = self.store.insert_order(row)
        row["id"] = oid
        self.orders[oid] = row
        if otype == "market":
            # Safe re-read: with_providers=False test setups still may have
            # lost the quote between check and here (nothing async can
            # interleave in this thread, but market_state is shared with
            # dispatch tasks — worst case we fill at whatever arrived).
            px = (self.market.get(symbol_key, {}) or {})["last"]
            self._execute(row, float(px))
        return row

    def cancel(self, order_id: int) -> bool:
        row = self.orders.get(order_id)
        if not row or row["status"] != "working":
            return False
        row["status"] = "canceled"
        row["updated"] = time.time()
        self.store.update_order(order_id, status="canceled", updated=row["updated"])
        del self.orders[order_id]
        return True

    def amend(self, order_id: int, qty: float | None = None,
              limit_price: float | None = None) -> dict:
        row = self.orders.get(order_id)
        if not row or row["status"] != "working":
            raise OrderError("only working orders can be amended")
        if qty is not None:
            if qty <= 0:
                raise OrderError("qty must be > 0")
            row["qty"] = float(qty)
        if limit_price is not None:
            row["limit_price"] = float(limit_price)
        self.store.update_order(order_id, qty=row["qty"], limit_price=row["limit_price"],
                                updated=time.time())
        return row

    def on_tick(self, ev: Trade) -> None:
        key = ev.symbol_key
        px = float(ev.price)
        # list() copy is load-bearing, not style: _execute removes the order
        # it is called for — whether it fills or the sell guard cancels it —
        # while this loop is still iterating self.orders, and mutating a dict
        # mid-iteration is a RuntimeError in modern Python.
        for oid in list(self.orders.keys()):
            row = self.orders.get(oid)
            if not row or row["symbol_key"] != key or row["status"] != "working":
                continue
            fill_px = self._evaluate(row, px)
            if fill_px is not None:
                self._execute(row, fill_px)

    def _evaluate(self, row: dict, px: float) -> Optional[float]:
        # Return the fill price if the tick triggers this order, else None.
        # Limit fills land at min/max(px, lp) — never worse than the limit,
        # and better when the market is already through it (a buy limit at
        # 100 watching a 98 tick buys at 98: marketable limits cross live
        # books at the market, not at your price; filling everything at the
        # limit would model price improvement away). Stop orders have no
        # price guard by definition: once triggered they fill at market, and
        # the slippage model is what keeps that honest-ish.
        t = row["otype"]
        side = row["side"]
        lp = row.get("limit_price")
        sp = row.get("stop_price")
        if t == "limit":
            if side == "buy" and px <= lp:
                return min(px, lp)
            if side == "sell" and px >= lp:
                return max(px, lp)
            return None
        if t == "stop":
            if side == "buy" and px >= sp:
                return px
            if side == "sell" and px <= sp:
                return px
            return None
        if t == "stop_limit":
            triggered = px >= sp if side == "buy" else px <= sp
            if not triggered:
                return None
            if side == "buy" and px <= lp:
                return min(px, lp)
            if side == "sell" and px >= lp:
                return max(px, lp)
            return None
        return None

    def _execute(self, row: dict, raw_px: float) -> None:
        """Fill (the remaining quantity of) an order at raw_px plus slippage.

        Order of writes matters: fill row first, then in-memory cash/position,
        then order status. A crash between "insert_fill" and "update_order"
        leaves the order displayed as working while the fill is already booked;
        _load() recomputes cash from fills, so the ledger stays right — the
        worst case is a cosmetic stale status. The reverse order (status then
        fill) would silently drop real money. Live with it, or put the three
        writes in one SQLite transaction (todo).
        """
        side = row["side"]
        qty = row["qty"] - row["filled_qty"]
        if side == "sell":
            # Re-check holdings at fill time, not just at submit: several
            # working sells on the same symbol can jointly exceed the
            # position, and the sells that trigger first eat it. The loser
            # is CANCELED, not filled into a short — paper accounts never
            # short (see _flatten_shorts), and raising here would abort the
            # rest of on_tick for every other order on this tick.
            held = self.positions.get(row["symbol_key"], {}).get("qty", 0.0)
            if held + 1e-9 < qty:
                row["status"] = "canceled"
                row["updated"] = time.time()
                self.store.update_order(
                    row["id"], status="canceled", updated=row["updated"]
                )
                self.orders.pop(row["id"], None)
                return
        # The ±1 on slippage is the SIGN FLIP that makes it a cost: buys
        # fill ABOVE the reference price, sells BELOW it — slippage always
        # hurts the trader regardless of side. Using |bps| symmetrically
        # would gift free money on every round trip, which is how paper
        # accounts start beating the market and quietly mean nothing.
        slip = raw_px * (1 + self.slippage_bps * 1e-4 * (1 if side == "buy" else -1))
        fee = round(slip * qty * self.commission_bps * 1e-4, 4)
        ts = time.time()
        fill_id = self.store.insert_fill(
            row["id"], row["symbol_key"], side, qty, round(slip, 8), fee, ts
        )
        self._apply_fill_math(row["symbol_key"], side, qty, slip, fee)
        self.cash -= self._cash_delta(side, qty, slip, fee)

        # Weighted average fill price. The old code bumped filled_qty BEFORE
        # weighting prev_avg by it, so with any hypothetical partial fills the
        # first slice's weight included the second slice's size. Only full
        # fills happen today, which is the sole reason nobody noticed: prev_avg
        # starts at 0 and the error is multiplied by zero. Fix it anyway —
        # partial fills are one feature flag away.
        prev_filled = row["filled_qty"]
        prev_avg = row["avg_fill"] or 0.0
        row["filled_qty"] = prev_filled + qty
        total_notional = prev_avg * prev_filled + slip * qty
        row["avg_fill"] = round(
            total_notional / row["filled_qty"] if row["filled_qty"] else 0, 8
        )
        row["status"] = "filled"
        row["updated"] = ts
        self.store.update_order(
            row["id"], status="filled", filled_qty=row["filled_qty"],
            avg_fill=row["avg_fill"], updated=ts,
        )
        del self.orders[row["id"]]
        self.bus.publish(
            f"fill:{row['symbol_key']}",
            FillEvent(
                symbol_key=row["symbol_key"],
                feed="PAPER",
                order_id=row["id"],
                fill_id=fill_id,
                side=side,
                qty=round(qty, 10),
                price=round(slip, 6),
                fee=fee,
            ),
        )

    def _apply_fill_math(self, key: str, side: str, qty: float, price: float,
                         fee: float) -> None:
        """Update weighted-average position after one fill. Pure in-memory.

        The `persist` parameter this used to carry was never read — a `del
        persist` is what passing dead code looks like six months later.
        """
        pos = self.positions.setdefault(key, {"qty": 0.0, "avg": 0.0, "realized": 0.0})
        signed = qty if side == "buy" else -qty
        if signed > 0:
            pos["avg"] = (
                (abs(pos["qty"]) * pos["avg"] + qty * price)
                / (abs(pos["qty"]) + qty)
                if pos["qty"] + qty != 0
                else price
            )
            pos["qty"] += qty
        else:
            closed = min(qty, pos["qty"])
            # NOTE the fee simplification: the FULL fill fee is charged to
            # realized pnl even when only part of the position closed. For a
            # partial close that shaves a few cents off pnl. Paper money.
            pnl = (price - pos["avg"]) * closed - (fee if closed > 0 else 0)
            pos["realized"] += pnl
            pos["qty"] -= qty
            if abs(pos["qty"]) < 1e-9:
                pos["qty"] = 0.0

    def portfolio(self) -> dict[str, Any]:
        out_positions = []
        unrealized_total = 0.0
        for key, pos in self.positions.items():
            if abs(pos["qty"]) < 1e-9:
                continue
            mark = (self.market.get(key) or {}).get("last")
            upnl = (mark - pos["avg"]) * pos["qty"] if mark else None
            if upnl is not None:
                unrealized_total += upnl
            out_positions.append({
                "symbol_key": key,
                "qty": pos["qty"],
                "avg_cost": round(pos["avg"], 6),
                "mark": mark,
                "value": round(pos["qty"] * mark, 2) if mark else None,
                "unrealized": round(upnl, 2) if upnl is not None else None,
                "unrealized_pct": (
                    round((mark / pos["avg"] - 1) * 100, 3)
                    if mark and pos["avg"]
                    else None
                ),
                "realized": round(pos["realized"], 2),
            })
        equity = self.cash + sum(p["value"] or 0 for p in out_positions)
        return {
            "cash": round(self.cash, 2),
            "equity": round(equity, 2),
            "unrealized": round(unrealized_total, 2),
            "positions": out_positions,
        }

    def analytics(self) -> dict[str, Any]:
        points = self.store.equity_points()
        stats: dict[str, Any] = {
            "points": points[-1000:],
            "trades": [],
        }
        if len(points) >= 2:
            values = [v for _, v in points]
            peak = values[0]
            max_dd = 0.0
            dds: list[float] = []
            rets: list[float] = []
            for i, v in enumerate(values):
                peak = max(peak, v)
                dd = v / peak - 1 if peak else 0.0
                dds.append(dd)
                max_dd = min(max_dd, dd)
                if i:
                    base = values[i - 1]
                    if base:
                        rets.append(v / base - 1)
            stats["max_dd_pct"] = round(max_dd * 100, 3)
            stats["total_return_pct"] = round((values[-1] / values[0] - 1) * 100, 3)
            if len(rets) >= 2:
                mean = sum(rets) / len(rets)
                var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
                sd = var ** 0.5
                # ANNUALIZATION IS A LIE, and here is why, so nobody "fixes"
                # it quietly: equity samples are 30s apart, but sqrt(252) is
                # the *daily*-return convention. sqrt-annualizing a 30-second
                # sample assumes 252 samples/year, understating volatility
                # ~2000x and inflating Sharpe accordingly. The honest factor
                # for 30s samples across a 6.5h*252 trading year would be
                # sqrt(2340), and even that ignores weekend/market-hour
                # structure — samples only accrue while the process runs, so
                # this number is descriptive, not comparable to fund-brochure
                # Sharpe. Kept sqrt(252) because the frontend tooltip labels
                # it "sharpe (daily-equivalent)"; changing the math without
                # changing every stored interpretation is how metrics die.
                stats["sharpe"] = (
                    round(mean / sd * (252 ** 0.5), 3) if sd > 0 else None
                )
            stats["drawdowns"] = [
                [ts, round(d * 100, 4)] for (ts, _), d in zip(points[-1000:], dds[-1000:])
            ]
        stats["trades"] = self._closed_trades()
        wins = [t for t in stats["trades"] if t["pnl"] > 0]
        losses = [t for t in stats["trades"] if t["pnl"] < 0]
        gross_win = sum(t["pnl"] for t in wins)
        gross_loss = -sum(t["pnl"] for t in losses)
        stats["win_rate"] = (
            round(len(wins) / len(stats["trades"]) * 100, 1)
            if stats["trades"] else None
        )
        stats["profit_factor"] = (
            round(gross_win / gross_loss, 3) if gross_loss > 0 else None
        )
        return stats

    def _closed_trades(self) -> list[dict[str, Any]]:
        """Round-trip PnL for charts: each sell is matched FIFO against open
        buy lots (earliest entry closes first — the convention everyone
        eyeballs, and the only one reconstructible from the fills table).
        Note the fee is PRORATED by lot here (take/f.qty), unlike
        _apply_fill_math's whole-fee-to-realized simplification — two
        ledgers, slightly different PnL, both paper. Sells that exceed the
        open lots match only what they can and report the matched qty,
        never a negative-lot fantasy."""
        _, fills = self.store.cash_flows()
        lots: dict[str, list[tuple[float, float]]] = {}
        trades: list[dict[str, Any]] = []
        for f in fills:
            key = f["symbol_key"]
            if f["side"] == "buy":
                lots.setdefault(key, []).append((f["price"], f["qty"]))
                continue
            remaining = f["qty"]
            pnl = 0.0
            qty_matched = 0.0
            while remaining > 1e-9 and lots.get(key):
                lot_px, lot_qty = lots[key][0]
                take = min(lot_qty, remaining)
                pnl += (f["price"] - lot_px) * take - (f["fee"] * take / f["qty"])
                lots[key][0] = (lot_px, lot_qty - take)
                if lots[key][0][1] <= 1e-9:
                    lots[key].pop(0)
                remaining -= take
                qty_matched += take
            if qty_matched > 0:
                trades.append({
                    "symbol_key": key,
                    "ts": f["ts"],
                    "qty": round(qty_matched, 10),
                    "exit": f["price"],
                    "pnl": round(pnl, 2),
                })
        return trades

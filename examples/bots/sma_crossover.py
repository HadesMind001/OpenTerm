"""
SMA Crossover — golden/death cross trend follower.

Buys when the fast SMA crosses above the slow SMA, sells when it crosses
back below. Positions are sized as a fixed fraction of buying power.

Config (editable in the Bots page → Config panel):
  symbol      str    market symbol key          (default "EQUITY:AAPL")
  interval    str    bar interval to trade      (default "1m")
  fast        int    fast SMA period            (default 9)
  slow        int    slow SMA period            (default 21)
  size_pct    float  fraction of buying power   (default 0.10)

NOTE: the FIRST LINE of this docstring is parsed by the Bots page
(`_parse_example_meta` splits "Name — description"). Keep that shape.
"""


def _sma(values, period):
    if len(values) < period:
        return None
    window = values[-period:]
    return sum(window) / period


class SmaCrossoverBot:
    async def on_start(self, ctx):
        self.symbol = ctx.config.get("symbol", "EQUITY:AAPL")
        self.interval = ctx.config.get("interval", "1m")
        self.fast = int(ctx.config.get("fast", 9))
        self.slow = int(ctx.config.get("slow", 21))
        self.size_pct = float(ctx.config.get("size_pct", 0.10))

        self.closes = []
        self.prev_fast = None
        self.prev_slow = None

        await ctx.subscribe_bars([self.symbol], self.interval)
        ctx.log("info", f"SMA crossover armed: {self.symbol} {self.interval} "
                        f"fast={self.fast} slow={self.slow}")

    async def on_bar(self, ctx, bar):
        if bar.symbol != self.symbol or not bar.closed:
            return

        self.closes.append(bar.c)
        keep = self.slow + 5
        if len(self.closes) > keep:
            self.closes = self.closes[-keep:]

        fast = _sma(self.closes, self.fast)
        slow = _sma(self.closes, self.slow)
        if fast is None or slow is None:
            return

        pos = await ctx.get_position(self.symbol)
        holding = pos is not None and pos.qty > 0

        golden = self.prev_fast is not None and self.prev_slow is not None
        # CROSS detection (prev ordering + current ordering flipped), not
        # "fast > slow": acting on the state instead of the edge would buy
        # the whole uptrend bar after bar the moment both SMAs have data.
        crossed_up = golden and self.prev_fast <= self.prev_slow and fast > slow
        crossed_dn = golden and self.prev_fast >= self.prev_slow and fast < slow

        if crossed_up and not holding:
            acct = await ctx.get_account()
            budget = acct.buying_power * self.size_pct
            qty = round(budget / bar.c, 4) if bar.c else 0
            if qty > 0:
                await ctx.place_order(
                    symbol=self.symbol, side="buy", order_type="market",
                    qty=qty, tif="day",
                )
                ctx.emit_signal("sma-cross-up", {"symbol": self.symbol, "qty": qty})
                ctx.log("info", f"BUY {qty} {self.symbol} @~{bar.c:.2f} (golden cross)")
        elif crossed_dn and holding:
            await ctx.place_order(
                symbol=self.symbol, side="sell", order_type="market",
                qty=pos.qty, tif="day",
            )
            ctx.emit_signal("sma-cross-down", {"symbol": self.symbol, "qty": pos.qty})
            ctx.log("info", f"SELL {pos.qty} {self.symbol} @~{bar.c:.2f} (death cross)")

        self.prev_fast, self.prev_slow = fast, slow

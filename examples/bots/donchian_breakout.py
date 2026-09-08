"""
Donchian Breakout — rides new N-bar highs, exits on break of low or stop.

Classic turtle-style channel breakout, simplified: buy a new `window`-bar
high, exit if price breaks the `exit_window`-bar low or tags the
protective stop. Entry price and stop are persisted, so a restart does
not lose track of an open trade.

Config (editable in the Bots page → Config panel):
  symbol        str    market symbol key       (default "EQUITY:QQQ")
  interval      str    bar interval to trade   (default "15m")
  window        int    breakout lookback       (default 20)
  exit_window   int    exit lookback           (default 10)
  stop_pct      float  protective stop %       (default 0.03)
  qty           float  fixed share size        (default 5)

NOTE: the FIRST LINE of this docstring is parsed by the Bots page
(`_parse_example_meta` splits "Name — description"). Keep that shape.
"""

ENTRY_KEY = "donchian.entry"
STOP_KEY = "donchian.stop"


class DonchianBreakoutBot:
    async def on_start(self, ctx):
        self.symbol = ctx.config.get("symbol", "EQUITY:QQQ")
        self.interval = ctx.config.get("interval", "15m")
        self.window = int(ctx.config.get("window", 20))
        self.exit_window = int(ctx.config.get("exit_window", 10))
        self.stop_pct = float(ctx.config.get("stop_pct", 0.03))
        self.qty = float(ctx.config.get("qty", 5))

        self.highs = []
        self.lows = []

        self.entry = float(await ctx.get_state(ENTRY_KEY) or 0) or None
        self.stop = float(await ctx.get_state(STOP_KEY) or 0) or None

        await ctx.subscribe_bars([self.symbol], self.interval)
        ctx.log("info", f"Donchian breakout armed: {self.symbol} {self.interval} "
                        f"window={self.window} exit={self.exit_window} stop={self.stop_pct:.0%}"
                        + (f" (resumed entry={self.entry} stop={self.stop})" if self.entry else ""))

    async def on_bar(self, ctx, bar):
        if bar.symbol != self.symbol or not bar.closed:
            return

        self.highs.append(bar.h)
        self.lows.append(bar.l)
        # keep is window+5, not window, because the breakout slice reads
        # `window + 1` entries ([-window-1:-1]). Trim to exactly `window`
        # and Python's forgiving slicing silently feeds a SHORTER channel
        # than the configured lookback — fewer bars, quieter entries, no
        # error. The +5 just makes that math obviously safe.
        keep = self.window + 5
        if len(self.highs) > keep:
            self.highs = self.highs[-keep:]
            self.lows = self.lows[-keep:]

        if len(self.highs) < self.window:
            return

        # [:-1] is NOT off-by-one sloppiness: a breakout compares the current
        # bar against the PRIOR N bars. Include the current bar in its own
        # channel and max() >= bar.c always — the entry could never fire.
        prior_high = max(self.highs[-self.window - 1:-1])
        exit_low = min(self.lows[-self.exit_window - 1:-1])
        pos = await ctx.get_position(self.symbol)
        holding = pos is not None and pos.qty > 0

        # stop first, channel exit second: if both trigger on the same bar,
        # the stop's (tighter) reason is the one you want in the log.
        if holding and self.stop and bar.c <= self.stop:
            await ctx.place_order(
                symbol=self.symbol, side="sell", order_type="market",
                qty=pos.qty, tif="day",
            )
            ctx.emit_signal("breakout-stop", {"symbol": self.symbol, "stop": self.stop})
            ctx.log("warn", f"STOP {self.symbol} @ {bar.c:.2f} hit stop {self.stop:.2f}")
            self.entry = self.stop = None
            await ctx.set_state(ENTRY_KEY, "")
            await ctx.set_state(STOP_KEY, "")
        elif holding and bar.c < exit_low:
            await ctx.place_order(
                symbol=self.symbol, side="sell", order_type="market",
                qty=pos.qty, tif="day",
            )
            ctx.emit_signal("breakout-exit", {"symbol": self.symbol, "price": bar.c})
            ctx.log("info", f"EXIT {self.symbol} @ {bar.c:.2f} — broke {self.exit_window}-bar low")
            self.entry = self.stop = None
            await ctx.set_state(ENTRY_KEY, "")
            await ctx.set_state(STOP_KEY, "")
        elif not holding and bar.c > prior_high:
            self.entry = bar.c
            self.stop = bar.c * (1.0 - self.stop_pct)
            await ctx.place_order(
                symbol=self.symbol, side="buy", order_type="market",
                qty=self.qty, tif="day",
            )
            ctx.emit_signal("breakout-entry", {"symbol": self.symbol, "price": self.entry})
            ctx.log("info", f"BUY {self.qty} {self.symbol} @ {bar.c:.2f} "
                            f"— new {self.window}-bar high, stop {self.stop:.2f}")
            await ctx.set_state(ENTRY_KEY, str(self.entry))
            await ctx.set_state(STOP_KEY, str(self.stop))

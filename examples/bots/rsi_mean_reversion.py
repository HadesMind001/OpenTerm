"""
RSI Mean-Reverter — buys oversold, sells overbought.

Wilder-smoothed RSI. Goes long when RSI drops under `buy_below` (flat
exit on recovery to `exit_level`), and buys back at `sell_above` if a
short is enabled. Purely counter-trend: no position is added.

Config (editable in the Bots page → Config panel):
  symbol      str    market symbol key        (default "EQUITY:SPY")
  interval    str    bar interval to trade    (default "5m")
  period      int    RSI lookback             (default 14)
  buy_below   float  long entry RSI level     (default 30)
  sell_above  float  long exit RSI level      (default 55)
  qty         float  fixed share size        (default 10)

NOTE: the FIRST LINE of this docstring is parsed by the Bots page
(`_parse_example_meta` splits "Name — description"). Keep that shape.
"""


class RsiMeanReversionBot:
    async def on_start(self, ctx):
        self.symbol = ctx.config.get("symbol", "EQUITY:SPY")
        self.interval = ctx.config.get("interval", "5m")
        self.period = int(ctx.config.get("period", 14))
        self.buy_below = float(ctx.config.get("buy_below", 30))
        self.sell_above = float(ctx.config.get("sell_above", 55))
        self.qty = float(ctx.config.get("qty", 10))

        self.closes = []
        self.avg_gain = None
        self.avg_loss = None
        self.rsi = None

        await ctx.subscribe_bars([self.symbol], self.interval)
        ctx.log("info", f"RSI mean-reverter armed: {self.symbol} {self.interval} "
                        f"period={self.period} buy<{self.buy_below} exit>{self.sell_above}")

    def _update_rsi(self, close):
        self.closes.append(close)
        if len(self.closes) < self.period + 1:
            return None
        if len(self.closes) == self.period + 1:
            gains, losses = [], []
            for i in range(1, self.period + 1):
                delta = self.closes[i] - self.closes[i - 1]
                gains.append(max(delta, 0.0))
                losses.append(max(-delta, 0.0))
            self.avg_gain = sum(gains) / self.period
            self.avg_loss = sum(losses) / self.period
        else:
            delta = self.closes[-1] - self.closes[-2]
            self.avg_gain = (self.avg_gain * (self.period - 1) + max(delta, 0.0)) / self.period
            self.avg_loss = (self.avg_loss * (self.period - 1) + max(-delta, 0.0)) / self.period
        if self.avg_loss == 0:
            # All-gain window: rs would divide by zero. RSI 100 is the
            # correct limit, not a fudge.
            return 100.0
        rs = self.avg_gain / self.avg_loss
        return 100.0 - (100.0 / (1.0 + rs))

    async def on_bar(self, ctx, bar):
        if bar.symbol != self.symbol or not bar.closed:
            return

        rsi = self._update_rsi(bar.c)
        if rsi is None:
            return
        prev = self.rsi
        self.rsi = rsi

        pos = await ctx.get_position(self.symbol)
        holding = pos is not None and pos.qty > 0

        # Chained comparisons = CROSS semantics, deliberately:
        # prev >= buy_below > rsi is true only on the bar that drops INTO
        # oversold. Acting on plain `rsi < buy_below` would re-buy every bar
        # while oversold and pyramid the whole move down (falling-knife
        # machine). Same argument reversed for the exit.
        crossed_into_oversold = prev is not None and prev >= self.buy_below > rsi
        recovered = prev is not None and prev <= self.sell_above < rsi

        if crossed_into_oversold and not holding:
            await ctx.place_order(
                symbol=self.symbol, side="buy", order_type="market",
                qty=self.qty, tif="day",
            )
            ctx.emit_signal("rsi-oversold", {"symbol": self.symbol, "rsi": rsi})
            ctx.log("info", f"BUY {self.qty} {self.symbol} — RSI {rsi:.1f} oversold")
        elif recovered and holding:
            await ctx.place_order(
                symbol=self.symbol, side="sell", order_type="market",
                qty=pos.qty, tif="day",
            )
            ctx.emit_signal("rsi-recovered", {"symbol": self.symbol, "rsi": rsi})
            ctx.log("info", f"SELL {pos.qty} {self.symbol} — RSI recovered to {rsi:.1f}")

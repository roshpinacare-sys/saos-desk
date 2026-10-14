// saos-desk backtest — lookahead-free walk-forward on REAL bars (R346)
// LAWS: pure; the strategy decides on bars[0..i], EXECUTION happens at bars[i+1] open.
// Exits ride the SAME hard-stop engine as the live desk (positions.mjs) — one risk law.
// This is the giants' gate: a kernel rule set must prove itself on real history
// before the desk trusts it. Paper validation only; nothing here is a return promise.

import { round4, clamp, sma, rsi, atr } from "./kernel.mjs";
import { deriveStops, markPosition } from "./positions.mjs";

// deterministic core strategy — the same signals the cabinet's technical/momentum
// agents read: trend (sma20 vs sma50) + momentum (RSI). Fully reproducible.
export function signalAt(bars, i, cfg = {}) {
  const rsiP = cfg.rsiPeriod ?? 14;
  const trendP = cfg.trendPeriod ?? 50;
  const midP = cfg.midPeriod ?? 20;
  const closes = bars.slice(0, i + 1).map((b) => b.c);
  if (closes.length < Math.max(trendP, rsiP) + 1) return { action: "flat", reason: "warmup" };
  const s20 = sma(closes, midP);
  const s50 = sma(closes, trendP);
  const r = rsi(closes, rsiP);
  if (s20 === null || s50 === null || r === null) return { action: "flat", reason: "indicators" };
  const up = s20 > s50;
  if (up && r < 55 && r > 35) return { action: "buy", reason: `trend-up rsi=${round4(r)}` };
  if (!up && r > 45 && r < 65) return { action: "sell", reason: `trend-down rsi=${round4(r)}` };
  return { action: "flat", reason: `no-edge rsi=${round4(r)}` };
}

// cooldown bars between entries per symbol (anti-churn law)
export function runBacktest(bars, { stopAtrMult = 2, rrTarget = 2, timeStopBars = 10, sizePct = 10, cooldownBars = 3 } = {}) {
  if (!Array.isArray(bars) || bars.length < 60) return { ok: false, reason: "bars-below-60" };
  for (const b of bars) {
    if (!(b.c > 0) || !(b.h >= b.l)) return { ok: false, reason: "malformed-bars" };
  }
  const trades = [];
  let pos = null;
  let lastEntryIdx = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // 1) manage the open position on THIS bar (stop/target/time use this bar's open)
    if (pos) {
      const { position, closed } = markPosition(pos, { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c }, { timeStopBars });
      pos = position.status === "OPEN" ? position : null;
      if (closed) trades.push(toTrade(closed, i));
    }
    // 2) entry decided on bars[0..i], executed at bars[i+1] open (lookahead-free);
    //    on the FINAL bar there is no next bar — the signal is recorded, never executed.
    if (!pos && i - lastEntryIdx > cooldownBars && i < bars.length - 1) {
      const sig = signalAt(bars, i, {});
      if (sig.action === "buy" || sig.action === "sell") {
        const a = atr(bars.slice(0, i + 1), 14);
        const entryBar = bars[i + 1];
        const stops = deriveStops(sig.action, entryBar.o, a, { stopAtrMult, rrTarget });
        if (stops) {
          pos = {
            id: `bt-${i}`,
            symbol: "backtest",
            side: sig.action,
            sizePct,
            status: "OPEN",
            entryPrice: round4(entryBar.o),
            stopPrice: stops.stopPrice,
            targetPrice: stops.targetPrice,
            riskPerUnit: stops.riskPerUnit,
            atrAtEntry: round4(a),
            openedAt: null,
            lastMark: round4(entryBar.o),
            unrealizedPct: 0,
            barsHeld: 0,
            events: [],
            _entryIdx: i + 1,
            _signal: sig.reason,
          };
          lastEntryIdx = i;
        }
      }
    }
  }
  // the final open position closes at the last close honestly (marked, not abandoned)
  if (pos) {
    const lastBar = bars[bars.length - 1];
    const { closed } = markPosition(pos, null, { timeStopBars: 1e9 });
    const finalPos = closed ?? { ...pos, status: "CLOSED", exitPrice: lastBar.c, realizedPct: round4(((lastBar.c - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "buy" ? 1 : -1)), closeReason: "END-OF-DATA" };
    trades.push(toTrade(finalPos, bars.length - 1, true));
  }

  const realized = trades.map((t) => t.realizedPct);
  const equity = [];
  let cum = 0;
  for (const r of realized) {
    cum += r * (sizePct / 100);
    equity.push(round4(cum));
  }
  const wins = realized.filter((r) => r > 0);
  const losses = realized.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalReturn = round4(equity[equity.length - 1] ?? 0);
  const sharpe = sharpeOf(realized.map((r) => r * (sizePct / 100)));
  const maxDD = maxDrawdown(equity);
  return {
    ok: true,
    bars: bars.length,
    trades,
    stats: {
      tradeCount: trades.length,
      hitRate: trades.length ? round4(wins.length / trades.length) : null,
      avgWinPct: wins.length ? round4(grossWin / wins.length) : null,
      avgLossPct: losses.length ? round4(-grossLoss / losses.length) : null,
      profitFactor: grossLoss > 0 ? round4(grossWin / grossLoss) : grossWin > 0 ? null : 0,
      totalReturnPct: totalReturn,
      sharpe: sharpe === null ? null : round4(sharpe),
      maxDrawdownPct: round4(maxDD),
      entryRule: "signal@close(i) → fill@open(i+1) — אפס-הצצה-קדימה",
      exitRule: "hard stops (stopAtrMult/rrTarget/timeStopBars) — אותו-מנוע-סיכון כמו-השולחן",
    },
    equity,
  };
}

function toTrade(p, exitIdx, endOfData = false) {
  return {
    side: p.side,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    realizedPct: p.realizedPct,
    closeReason: endOfData ? "END-OF-DATA" : p.closeReason,
    barsHeld: p.barsHeld,
    entryIdx: p._entryIdx ?? null,
    exitIdx,
    signal: p._signal ?? null,
  };
}

export function sharpeOf(returns) {
  if (returns.length < 3) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return mean > 0 ? 99 : 0;
  return (mean / sd) * Math.sqrt(252 / 5); // ~trade-frequency annualization (5 trading days per sample)
}

export function maxDrawdown(equityPctList) {
  let cum = 0, peak = 0, dd = 0;
  for (const r of equityPctList) {
    cum += r;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

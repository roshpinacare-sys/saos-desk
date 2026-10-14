// saos-desk backtest — TS port (R346)
// Faithful port of repos/saos-desk/src/backtest.mjs (source of truth).
// Pure, lookahead-free: signal decided on close(i), filled at open(i+1).
// Exits ride the SAME hard-stop engine as the live desk (positions.ts) — one risk law.

import { sma, rsi, atr, round4 } from "./engine";
import { deriveStops, markPosition, type MarkBar, type PositionCfg } from "./positions";

export interface SignalResult {
  action: "buy" | "sell" | "flat";
  reason: string;
}

export function signalAt(bars: MarkBar[], i: number, cfg: { rsiPeriod?: number; trendPeriod?: number; midPeriod?: number } = {}): SignalResult {
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

export interface BtTrade {
  side: string;
  entryPrice: number;
  exitPrice: number;
  realizedPct: number;
  closeReason: string;
  barsHeld: number;
  entryIdx: number | null;
  exitIdx: number;
  signal: string | null;
}

export interface BtStats {
  tradeCount: number;
  hitRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  totalReturnPct: number;
  sharpe: number | null;
  maxDrawdownPct: number;
  entryRule: string;
  exitRule: string;
}

export interface BacktestResult {
  ok: boolean;
  reason?: string;
  bars?: number;
  trades?: BtTrade[];
  stats?: BtStats;
  equity?: number[];
}

export function runBacktest(
  bars: MarkBar[],
  cfg: PositionCfg & { sizePct?: number; cooldownBars?: number } = {}
): BacktestResult {
  const { sizePct = 10, cooldownBars = 3, ...posCfg } = cfg;
  if (!Array.isArray(bars) || bars.length < 60) return { ok: false, reason: "bars-below-60" };
  for (const b of bars) {
    if (!(b.c > 0) || !(b.h >= b.l)) return { ok: false, reason: "malformed-bars" };
  }
  const trades: BtTrade[] = [];
  let pos: (PaperPositionLite & { _entryIdx?: number; _signal?: string | null }) | null = null;
  let lastEntryIdx = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (pos) {
      const { position, closed } = markPosition(pos, { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c }, { timeStopBars: posCfg.timeStopBars });
      pos = position.status === "OPEN" ? position : null;
      if (closed) trades.push(toTrade(closed, i));
    }
    if (!pos && i - lastEntryIdx > cooldownBars && i < bars.length - 1) {
      const sig = signalAt(bars, i, {});
      if (sig.action === "buy" || sig.action === "sell") {
        const a = atr(bars.slice(0, i + 1).map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: 0 })), 14);
        const entryBar = bars[i + 1];
        const stops = deriveStops(sig.action, entryBar.o, a, posCfg);
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
  if (pos) {
    const lastBar = bars[bars.length - 1];
    const { closed } = markPosition(pos, null, { timeStopBars: 1e9 });
    const finalPos: PaperPositionLite =
      closed ??
      ({
        ...pos,
        status: "CLOSED",
        exitPrice: lastBar.c,
        realizedPct: round4(
          ((lastBar.c - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "buy" ? 1 : -1)
        ),
        closeReason: "END-OF-DATA",
      } as PaperPositionLite);
    trades.push(toTrade(finalPos, bars.length - 1, true));
  }

  const realized = trades.map((t) => t.realizedPct);
  const equity: number[] = [];
  let cum = 0;
  for (const r of realized) {
    cum += r * (sizePct / 100);
    equity.push(round4(cum));
  }
  const wins = realized.filter((r) => r > 0);
  const losses = realized.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sharpe = sharpeOf(realized.map((r) => r * (sizePct / 100)));
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
      totalReturnPct: round4(equity[equity.length - 1] ?? 0),
      sharpe: sharpe === null ? null : round4(sharpe),
      maxDrawdownPct: round4(maxDrawdown(equity)),
      entryRule: "signal@close(i) → fill@open(i+1) — אפס-הצצה-קדימה",
      exitRule: "hard stops (stopAtrMult/rrTarget/timeStopBars) — אותו-מנוע-סיכון כמו-השולחן",
    },
    equity,
  };
}

interface PaperPositionLite {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  sizePct: number;
  status: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPerUnit: number;
  atrAtEntry: number;
  openedAt: string | null;
  lastMark: number;
  unrealizedPct: number;
  barsHeld: number;
  events: { type: string; at: string | null; price: number }[];
  exitPrice?: number | null;
  realizedPct?: number | null;
  closedAt?: string | null;
  closeReason?: string | null;
}

function toTrade(p: PaperPositionLite, exitIdx: number, endOfData = false): BtTrade {
  return {
    side: p.side,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice ?? p.lastMark,
    realizedPct: p.realizedPct ?? 0,
    closeReason: endOfData ? "END-OF-DATA" : (p.closeReason ?? "UNKNOWN"),
    barsHeld: p.barsHeld,
    entryIdx: (p as { _entryIdx?: number })._entryIdx ?? null,
    exitIdx,
    signal: (p as { _signal?: string | null })._signal ?? null,
  };
}

export function sharpeOf(returns: number[]): number | null {
  if (returns.length < 3) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return mean > 0 ? 99 : 0;
  return (mean / sd) * Math.sqrt(252 / 5);
}

export function maxDrawdown(equityPctList: number[]): number {
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const r of equityPctList) {
    cum += r;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

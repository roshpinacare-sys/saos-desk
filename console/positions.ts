// saos-desk positions — TS port (R346)
// Faithful port of repos/saos-desk/src/positions.mjs (source of truth).
// Pure — client-safe: no clock, no randomness, no network, no fs.
// Hard stops, declared fill model (gap→open, touch→stop level, tie→stop wins).

export const OPEN = "OPEN";
export const CLOSED = "CLOSED";

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface PositionCfg {
  stopAtrMult?: number;
  rrTarget?: number;
  timeStopBars?: number;
}

export interface PositionEvent {
  type: string;
  at: string | null;
  price: number;
}

export interface PaperPosition {
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
  prevSig?: string | null;
  lastMark: number;
  unrealizedPct: number;
  barsHeld: number;
  events: PositionEvent[];
  exitPrice?: number | null;
  realizedPct?: number | null;
  closedAt?: string | null;
  closeReason?: string | null;
}

export function deriveStops(side: "buy" | "sell", entry: number, atrValue: number, cfg: PositionCfg = {}) {
  const stopAtrMult = cfg.stopAtrMult ?? 2;
  const rrTarget = cfg.rrTarget ?? 2;
  if (!(atrValue > 0) || !(entry > 0)) return null;
  const risk = stopAtrMult * atrValue;
  if (side === "buy") {
    return {
      stopPrice: round4(entry - risk),
      targetPrice: round4(entry + risk * rrTarget),
      riskPerUnit: round4(risk),
    };
  }
  if (side === "sell") {
    return {
      stopPrice: round4(entry + risk),
      targetPrice: round4(entry - risk * rrTarget),
      riskPerUnit: round4(risk),
    };
  }
  return null;
}

export interface GateResult {
  allowed: boolean;
  reasons: string[];
  gross: number;
  maxGross: number;
  maxOpen: number;
}

export function openGate({
  openPositions,
  side,
  sizePct,
  symbol,
  maxPositionPct,
  positionsCfg,
}: {
  openPositions: Pick<PaperPosition, "symbol" | "sizePct" | "status">[];
  side: string;
  sizePct: number;
  symbol: string;
  maxPositionPct: number;
  positionsCfg?: { maxOpenPositions?: number; maxGrossExposurePct?: number };
}): GateResult {
  const cfg = positionsCfg ?? {};
  const maxOpen = cfg.maxOpenPositions ?? 5;
  const maxGross = cfg.maxGrossExposurePct ?? 50;
  const reasons: string[] = [];
  if (openPositions.length >= maxOpen) reasons.push(`מספר-עמדות-פתוחות ${openPositions.length} ≥ תקרת-המנדט ${maxOpen}`);
  if (openPositions.some((p) => p.symbol === symbol)) reasons.push(`ל${symbol} כבר קיימת עמדה — אין התאמה-כפולה לאותו-סמל`);
  const gross = openPositions.reduce((a, p) => a + p.sizePct, 0);
  if (gross + sizePct > maxGross) reasons.push(`חשיפה-גולמית ${round4(gross + sizePct)}% > תקרה ${maxGross}%`);
  if (sizePct <= 0) reasons.push("גודל-עמדה חייב להיות חיובי");
  if (side !== "buy" && side !== "sell") reasons.push(`צד לא-חוקי: ${side}`);
  if (sizePct > maxPositionPct) reasons.push(`גודל ${sizePct}% > מרבי-מנדט ${maxPositionPct}%`);
  return { allowed: reasons.length === 0, reasons, gross: round4(gross), maxGross, maxOpen };
}

export function openPosition({
  id,
  symbol,
  side,
  sizePct,
  entryPrice,
  atrValue,
  at,
  cfg,
  prevSig = null,
}: {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  sizePct: number;
  entryPrice: number;
  atrValue: number;
  at: string | null;
  cfg: PositionCfg;
  prevSig?: string | null;
}): { ok: boolean; reason?: string; position?: PaperPosition } {
  const stops = deriveStops(side, entryPrice, atrValue, cfg);
  if (!stops) return { ok: false, reason: "STOPS-DERIVATION-FAILED" };
  return {
    ok: true,
    position: {
      id,
      symbol,
      side,
      sizePct: round4(sizePct),
      status: OPEN,
      entryPrice: round4(entryPrice),
      stopPrice: stops.stopPrice,
      targetPrice: stops.targetPrice,
      riskPerUnit: stops.riskPerUnit,
      atrAtEntry: round4(atrValue),
      openedAt: at,
      prevSig,
      lastMark: round4(entryPrice),
      unrealizedPct: 0,
      barsHeld: 0,
      events: [{ type: "OPEN", at, price: round4(entryPrice) }],
    },
  };
}

export interface MarkBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export function markPosition(
  position: PaperPosition,
  bar: MarkBar | null,
  cfg: PositionCfg = {},
  { nowIso = null }: { nowIso?: string | null } = {}
): { position: PaperPosition; closed: PaperPosition | null } {
  if (position.status !== OPEN) return { position, closed: null };
  const timeStopBars = cfg.timeStopBars ?? 10;
  const p: PaperPosition = { ...position, events: [...position.events] };
  const mark = bar ? bar.c : p.lastMark;
  p.lastMark = round4(mark);
  p.barsHeld = (p.barsHeld ?? 0) + (bar ? 1 : 0);
  const movePct =
    p.side === "buy" ? ((mark - p.entryPrice) / p.entryPrice) * 100 : ((p.entryPrice - mark) / p.entryPrice) * 100;
  p.unrealizedPct = round4(movePct);

  if (!bar) return { position: p, closed: null };

  const o = Number.isFinite(bar.o) && bar.o > 0 ? bar.o : bar.c;
  let exitPrice: number | null = null;
  let reason: string | null = null;
  if (p.side === "buy") {
    if (o <= p.stopPrice) {
      exitPrice = o;
      reason = "STOP-LOSS";
    } else if (bar.l <= p.stopPrice) {
      exitPrice = p.stopPrice;
      reason = "STOP-LOSS";
    } else if (o >= p.targetPrice) {
      exitPrice = o;
      reason = "TAKE-PROFIT";
    } else if (bar.h >= p.targetPrice) {
      exitPrice = p.targetPrice;
      reason = "TAKE-PROFIT";
    }
  } else {
    if (o >= p.stopPrice) {
      exitPrice = o;
      reason = "STOP-LOSS";
    } else if (bar.h >= p.stopPrice) {
      exitPrice = p.stopPrice;
      reason = "STOP-LOSS";
    } else if (o <= p.targetPrice) {
      exitPrice = o;
      reason = "TAKE-PROFIT";
    } else if (bar.l <= p.targetPrice) {
      exitPrice = p.targetPrice;
      reason = "TAKE-PROFIT";
    }
  }
  if (!reason && p.barsHeld >= timeStopBars) {
    exitPrice = o;
    reason = "TIME-STOP";
  }
  if (!reason) return { position: p, closed: null };

  const exitPct =
    p.side === "buy"
      ? ((exitPrice - p.entryPrice) / p.entryPrice) * 100
      : ((p.entryPrice - exitPrice) / p.entryPrice) * 100;
  const closed: PaperPosition = {
    ...p,
    status: CLOSED,
    exitPrice: round4(exitPrice),
    realizedPct: round4(exitPct),
    closedAt: nowIso,
    closeReason: reason,
    events: [...p.events, { type: reason, at: nowIso, price: round4(exitPrice) }],
  };
  return { position: closed, closed };
}

export function markBook(
  positions: PaperPosition[],
  barsBySymbol: Record<string, MarkBar | null>,
  cfg: PositionCfg = {},
  { nowIso = null }: { nowIso?: string | null } = {}
): { book: PaperPosition[]; closes: PaperPosition[] } {
  const book: PaperPosition[] = [];
  const closes: PaperPosition[] = [];
  for (const pos of positions) {
    const bar = barsBySymbol[pos.symbol] ?? null;
    const r = markPosition(pos, bar, cfg, { nowIso });
    book.push(r.position);
    if (r.closed) closes.push(r.closed);
  }
  return { book, closes };
}

export interface PortfolioState {
  openCount: number;
  closedCount: number;
  grossExposurePct: number;
  netExposurePct: number;
  unrealizedPct: number;
  realizedPct: number;
  hitRate: number | null;
  drawdownPct: number;
}

export function portfolioState(book: PaperPosition[], equityPctList: number[] = []): PortfolioState {
  const open = book.filter((p) => p.status === OPEN);
  const closed = book.filter((p) => p.status === CLOSED);
  const gross = round4(open.reduce((a, p) => a + p.sizePct, 0));
  const net = round4(open.reduce((a, p) => a + (p.side === "buy" ? p.sizePct : -p.sizePct), 0));
  const unrealized = round4(open.reduce((a, p) => a + (p.unrealizedPct ?? 0) * (p.sizePct / 100), 0));
  const realized = round4(closed.reduce((a, p) => a + (p.realizedPct ?? 0), 0));
  const wins = closed.filter((p) => (p.realizedPct ?? 0) > 0).length;
  return {
    openCount: open.length,
    closedCount: closed.length,
    grossExposurePct: gross,
    netExposurePct: net,
    unrealizedPct: unrealized,
    realizedPct: realized,
    hitRate: closed.length ? round4(wins / closed.length) : null,
    drawdownPct: computeDrawdownPct([...(equityPctList ?? []), unrealized + realized]),
  };
}

export function computeDrawdownPct(pctList: number[]): number {
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const r of pctList) {
    const v = typeof r === "number" && Number.isFinite(r) ? r : 0;
    cum += v;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return round4(dd);
}

export function historicalVaR(
  weights: Record<string, number>,
  returnsBySymbol: Record<string, number[]>,
  { confidence = 0.95 }: { confidence?: number } = {}
): { ok: boolean; reason?: string; varPct?: number | null; confidence?: number; samples?: number } {
  const symbols = Object.keys(weights).filter(
    (s) => (weights[s] ?? 0) !== 0 && Array.isArray(returnsBySymbol[s])
  );
  if (symbols.length === 0) return { ok: false, reason: "no-data", varPct: null };
  const len = Math.min(...symbols.map((s) => returnsBySymbol[s].length));
  if (len < 10) return { ok: false, reason: "history-too-short", varPct: null };
  const port: number[] = [];
  for (let i = 0; i < len; i++) {
    let r = 0;
    for (const s of symbols) r += (weights[s] ?? 0) * returnsBySymbol[s][returnsBySymbol[s].length - len + i];
    port.push(r);
  }
  const sorted = [...port].sort((a, b) => a - b);
  const idx = clamp(Math.floor((1 - confidence) * len), 0, len - 1);
  return { ok: true, varPct: round4(sorted[idx] * 100), confidence, samples: len };
}

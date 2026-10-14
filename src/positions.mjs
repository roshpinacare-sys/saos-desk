// saos-desk positions — the paper position lifecycle engine (R346)
// LAWS: pure — no clock, no randomness, no network, no fs.
// The giants' loop, sovereign: a chair decision becomes a POSITION, positions get
// marked-to-market on live artery prices, hard stops fire without discretion.
// Lookahead law: entries/exits execute on the bar AFTER the information exists.
// REFRAIN law: a desk-wide REFRAIN blocks NEW positions (marks still run honestly).

import { round4, clamp } from "./kernel.mjs";

export const OPEN = "OPEN";
export const CLOSED = "CLOSED";

// ---- stop placement (from the mandate, never discretion) ----------------------
export function deriveStops(side, entry, atrValue, cfg) {
  const stopAtrMult = cfg?.stopAtrMult ?? 2;
  const rrTarget = cfg?.rrTarget ?? 2;
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

// ---- open gate: exposure caps are the mandate, fail-closed --------------------
export function openGate({ openPositions, side, sizePct, symbol, mandate, positionsCfg }) {
  const cfg = positionsCfg ?? {};
  const maxOpen = cfg.maxOpenPositions ?? 5;
  const maxGross = cfg.maxGrossExposurePct ?? 50;
  const maxPerSymbol = mandate.limits.maxPositionPct;
  const reasons = [];
  if (openPositions.length >= maxOpen) reasons.push(`מספר-עמדות-פתוחות ${openPositions.length} ≥ תקרת-המנדט ${maxOpen}`);
  const sameSymbol = openPositions.filter((p) => p.symbol === symbol);
  if (sameSymbol.length > 0) reasons.push(`ל${symbol} כבר קיימת עמדה — אין התאמה-כפולה לאותו-סמל`);
  const gross = openPositions.reduce((a, p) => a + p.sizePct, 0);
  if (gross + sizePct > maxGross) reasons.push(`חשיפה-גולמית ${round4(gross + sizePct)}% > תקרה ${maxGross}%`);
  if (sizePct <= 0) reasons.push("גודל-עמדה חייב להיות חיובי");
  if (side !== "buy" && side !== "sell") reasons.push(`צד לא-חוקי: ${side}`);
  return { allowed: reasons.length === 0, reasons, gross: round4(gross), maxGross, maxOpen };
}

export function openPosition({ id, symbol, side, sizePct, entryPrice, atrValue, at, cfg, prevSig = null }) {
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

// ---- mark-to-market + hard stops (no discretion, no forgiveness) ---------------
// Fill model (declared law, giants-style):
//   stop: gap-through at open fills at OPEN (worse), intraday touch fills AT the stop level.
//   target: gap-through at open fills at OPEN (better), intraday touch fills AT the target level.
//   Both in one bar → the STOP wins (conservative tie law).
//   bar=null → no trigger evaluation (no clock, no invention); mark carries.
export function markPosition(position, bar, cfg, { nowIso = null } = {}) {
  if (position.status !== OPEN) return { position, closed: null };
  const cfgOut = cfg ?? {};
  const timeStopBars = cfgOut.timeStopBars ?? 10;
  const p = { ...position, events: [...position.events] };
  const mark = bar ? bar.c : p.lastMark;
  p.lastMark = round4(mark);
  p.barsHeld = (p.barsHeld ?? 0) + (bar ? 1 : 0);
  const movePct = p.side === "buy" ? ((mark - p.entryPrice) / p.entryPrice) * 100 : ((p.entryPrice - mark) / p.entryPrice) * 100;
  p.unrealizedPct = round4(movePct);

  if (!bar) return { position: p, closed: null };

  const isOpen = (x) => Number.isFinite(x) && x > 0 ? x : bar.c;
  const o = isOpen(bar.o);
  let exitPrice = null;
  let reason = null;
  if (p.side === "buy") {
    if (o <= p.stopPrice) { exitPrice = o; reason = "STOP-LOSS"; }
    else if (bar.l <= p.stopPrice) { exitPrice = p.stopPrice; reason = "STOP-LOSS"; }
    else if (o >= p.targetPrice) { exitPrice = o; reason = "TAKE-PROFIT"; }
    else if (bar.h >= p.targetPrice) { exitPrice = p.targetPrice; reason = "TAKE-PROFIT"; }
  } else {
    if (o >= p.stopPrice) { exitPrice = o; reason = "STOP-LOSS"; }
    else if (bar.h >= p.stopPrice) { exitPrice = p.stopPrice; reason = "STOP-LOSS"; }
    else if (o <= p.targetPrice) { exitPrice = o; reason = "TAKE-PROFIT"; }
    else if (bar.l <= p.targetPrice) { exitPrice = p.targetPrice; reason = "TAKE-PROFIT"; }
  }
  if (!reason && p.barsHeld >= timeStopBars) { exitPrice = o; reason = "TIME-STOP"; }
  if (!reason) return { position: p, closed: null };

  const exitPct = p.side === "buy" ? ((exitPrice - p.entryPrice) / p.entryPrice) * 100 : ((p.entryPrice - exitPrice) / p.entryPrice) * 100;
  const closed = {
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

// mark a whole book; returns {book, closes}
export function markBook(positions, barsBySymbol, cfg, { nowIso = null } = {}) {
  const book = [];
  const closes = [];
  for (const pos of positions) {
    const bar = barsBySymbol?.[pos.symbol] ?? null;
    const r = markPosition(pos, bar, cfg, { nowIso });
    book.push(r.position);
    if (r.closed) closes.push(r.closed);
  }
  return { book, closes };
}

// ---- portfolio risk (the giants' desk metrics, deterministic) ------------------
export function portfolioState(book, equityPctList = []) {
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

export function computeDrawdownPct(pctList) {
  let cum = 0, peak = 0, dd = 0;
  for (const r of pctList) {
    const v = typeof r === "number" && Number.isFinite(r) ? r : 0;
    cum += v;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return round4(dd);
}

// historical-simulation VaR on position-weighted daily returns (pure, no clock)
export function historicalVaR(weights, returnsBySymbol, { confidence = 0.95 } = {}) {
  // weights: {symbol: pct/100}; returnsBySymbol: {symbol: number[]} equal-length daily return fractions
  const symbols = Object.keys(weights).filter((s) => (weights[s] ?? 0) !== 0 && Array.isArray(returnsBySymbol[s]));
  if (symbols.length === 0) return { ok: false, reason: "no-data", varPct: null };
  const len = Math.min(...symbols.map((s) => returnsBySymbol[s].length));
  if (len < 10) return { ok: false, reason: "history-too-short", varPct: null };
  const port = [];
  for (let i = 0; i < len; i++) {
    let r = 0;
    for (const s of symbols) r += (weights[s] ?? 0) * returnsBySymbol[s][returnsBySymbol[s].length - len + i];
    port.push(r);
  }
  const sorted = [...port].sort((a, b) => a - b);
  const idx = clamp(Math.floor((1 - confidence) * len), 0, len - 1);
  return { ok: true, varPct: round4(sorted[idx] * 100), confidence, samples: len };
}

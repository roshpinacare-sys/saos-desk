// saos-desk kernel — the deterministic quant core (R338)
// LAWS: no clock, no unseeded randomness, no network, no fs in this module.
// Every number a downstream agent sees is reproducible from (seed, symbol).

// ---- deterministic PRNG (mulberry32) ----------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- FNV-1a 32-bit string hash ----------------------------------------------
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round4 = (x) => Math.round(x * 10000) / 10000;
export const tanh = Math.tanh;

// ---- synthetic OHLCV series (sim, honestly labelled) -------------------------
// 4-uniform Irwin-Hall-ish gaussian approximation, centered.
export function genSeries(seed, symbol, n = 140) {
  const h = hash32(symbol);
  const rng = mulberry32((h ^ (seed >>> 0)) >>> 0);
  const base = 20 + (h % 481); // 20..500 — stable per-symbol character
  const drift = (rng() - 0.5) * 0.002;
  const vol = 0.006 + rng() * 0.012; // realistic daily stock vol 0.6%–1.8% (ATR% lands ~0.7–2.0)
  let price = base;
  const bars = [];
  for (let i = 0; i < n; i++) {
    const g = (rng() + rng() + rng() + rng() - 2) * vol;
    const o = price;
    const c = o * (1 + drift + g);
    const hi = Math.max(o, c) * (1 + rng() * vol * 0.8);
    const lo = Math.min(o, c) * (1 - rng() * vol * 0.8);
    const v = Math.round(50000 + rng() * 250000);
    bars.push({ o: round4(o), h: round4(hi), l: round4(lo), c: round4(c), v });
    price = c;
  }
  return bars;
}

// ---- indicators (pure) -------------------------------------------------------
export function sma(values, p) {
  if (values.length < p) return null;
  let s = 0;
  for (let i = values.length - p; i < values.length; i++) s += values[i];
  return s / p;
}

export function ema(values, p) {
  if (values.length < p) return null;
  const k = 2 / (p + 1);
  let e = values.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (gain + loss === 0) return 50;
  if (loss === 0) return 100;
  if (gain === 0) return 0;
  const rs = gain / p / (loss / p);
  return 100 - 100 / (1 + rs);
}

export function atr(bars, p = 14) {
  if (bars.length < p + 1) return null;
  let s = 0;
  for (let i = bars.length - p; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    s += tr;
  }
  return s / p;
}

export function bollinger(closes, p = 20, k = 2) {
  const mid = sma(closes, p);
  if (mid === null) return null;
  let sq = 0;
  for (let i = closes.length - p; i < closes.length; i++) sq += (closes[i] - mid) ** 2;
  const sd = Math.sqrt(sq / p);
  return { mid, upper: mid + k * sd, lower: mid - k * sd, sd, z: sd === 0 ? 0 : (closes[closes.length - 1] - mid) / (k * sd) };
}

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const eFast = ema(closes, fast), eSlow = ema(closes, slow);
  if (eFast === null || eSlow === null) return null;
  const line = eFast - eSlow;
  // signal approximated from the recent window's ema of the line is not feasible
  // without the full series; use deterministic single-pass approximation on closes:
  const histProxy = closes[closes.length - 1] - closes[Math.max(0, closes.length - slow)];
  return { line, signal: null, hist: histProxy, zero: line > 0 };
}

// ---- snapshot ----------------------------------------------------------------
// forwardBars: bars reserved for the sim close-out (never shown to agents)
export function snapshot(seed, symbol, klass, used = 120, forward = 20) {
  const bars = genSeries(seed, symbol, used + forward);
  const seen = bars.slice(0, used);
  const closes = seen.map((b) => b.c);
  const price = closes[closes.length - 1];
  const a = atr(seen, 14) ?? price * 0.01;
  const s20 = sma(closes, 20) ?? price;
  const s50 = sma(closes, 50) ?? price;
  const trendScore = clamp(tanh((s20 - s50) / s50 / 0.02), -1, 1);
  const volPct = (a / price) * 100;
  const regime =
    Math.abs(trendScore) > 0.45
      ? trendScore > 0 ? "trend-up" : "trend-down"
      : volPct > 2.0 ? "choppy-highvol" : "choppy-lowvol";
  return {
    seed,
    symbol, klass,
    bars: seen,
    price: round4(price),
    atr14: round4(a),
    rsi14: round4(rsi(closes, 14) ?? 50),
    sma20: round4(s20),
    sma50: round4(s50),
    trendScore: round4(trendScore),
    volPct: round4(volPct),
    regime,
    source: "sim",
    // sim close-out window (used ONLY by outcome() — agents never see it)
    _forward: bars.slice(used),
  };
}

export function simOutcome(snap, decision, sizePct, horizon = 20) {
  const f = snap._forward.slice(0, horizon);
  if (f.length === 0) return { realizedPct: 0, simClosed: true };
  const entry = snap.price;
  const exit = f[f.length - 1].c;
  const movePct = ((exit - entry) / entry) * 100;
  const dir = decision === "buy" ? 1 : decision === "sell" ? -1 : 0;
  const frac = sizePct / 100;
  return { realizedPct: round4(movePct * dir * frac), simClosed: true };
}

// ---- canonical signature (8 hex of sha256 over canonical JSON) ---------------
// Contract: payload WITHOUT the signature field (T-88 law).
export function canonical(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

import { createHash } from "node:crypto";
export function sig8(payloadWithoutSig) {
  return createHash("sha256").update(canonical(payloadWithoutSig)).digest("hex").slice(0, 8);
}

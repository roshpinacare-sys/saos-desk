// saos-desk engine — TypeScript port of the proven deterministic core (R338)
// Sources (ported EXACTLY, kept bit-compatible):
//   repos/saos-desk/src/kernel.mjs      — mulberry32, hash32, genSeries, indicators, snapshot, simOutcome, canonical, sig8
//   repos/saos-desk/src/agents.mjs      — 5 cabinet specialists with Hebrew reasons
//   repos/saos-desk/src/boardroom.mjs   — weightedMajority, weightedConf, debate, chair, riskGate, computeDrawdown
//   repos/saos-desk/src/reflexivity.mjs — evolve (Darwinian weights, clamped [0.5, 2.0])
//   repos/saos-desk/src/cycle.mjs       — one-beat artifact composition (saos-desk/session@1)
// LAWS: no clock, no unseeded randomness, no network, no fs in the pure path.
// Every number a downstream agent sees is reproducible from (seed, symbol).
import { createHash } from "node:crypto";
import { AGENTS } from "./mandate";
import type {
  AgentAction,
  AgentId,
  AgentWeightEntry,
  Bar,
  DebateRound,
  Decision,
  DeskArtifact,
  Mandate,
  Regime,
  RiskGateResult,
  Rng,
  Snapshot,
  Verdict,
  Weights,
  WeightDelta,
} from "./types";

// ---- deterministic PRNG (mulberry32) ----------------------------------------
export function mulberry32(seed: number): Rng {
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
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// ---- synthetic OHLCV series (sim, honestly labelled) -------------------------
// 4-uniform Irwin-Hall-ish gaussian approximation, centered.
export function genSeries(seed: number, symbol: string, n: number = 140): Bar[] {
  const h = hash32(symbol);
  const rng = mulberry32((h ^ (seed >>> 0)) >>> 0);
  const base = 20 + (h % 481); // 20..500 — stable per-symbol character
  const drift = (rng() - 0.5) * 0.002;
  const vol = 0.006 + rng() * 0.012; // realistic daily stock vol 0.6%–1.8% (ATR% lands ~0.7–2.0)
  let price = base;
  const bars: Bar[] = [];
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
export function sma(values: number[], p: number): number | null {
  if (values.length < p) return null;
  let s = 0;
  for (let i = values.length - p; i < values.length; i++) s += values[i];
  return s / p;
}

export function ema(values: number[], p: number): number | null {
  if (values.length < p) return null;
  const k = 2 / (p + 1);
  let e = values.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], p: number = 14): number | null {
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

export function atr(bars: Bar[], p: number = 14): number | null {
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

export function bollinger(closes: number[], p: number = 20, k: number = 2) {
  const mid = sma(closes, p);
  if (mid === null) return null;
  let sq = 0;
  for (let i = closes.length - p; i < closes.length; i++) sq += (closes[i] - mid) ** 2;
  const sd = Math.sqrt(sq / p);
  return { mid, upper: mid + k * sd, lower: mid - k * sd, sd, z: sd === 0 ? 0 : (closes[closes.length - 1] - mid) / (k * sd) };
}

export function macd(closes: number[], fast: number = 12, slow: number = 26, _sig: number = 9) {
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
export function snapshot(seed: number, symbol: string, klass: string, used: number = 120, forward: number = 20): Snapshot {
  const bars = genSeries(seed, symbol, used + forward);
  const seen = bars.slice(0, used);
  const closes = seen.map((b) => b.c);
  const price = closes[closes.length - 1];
  const a = atr(seen, 14) ?? price * 0.01;
  const s20 = sma(closes, 20) ?? price;
  const s50 = sma(closes, 50) ?? price;
  const trendScore = clamp(Math.tanh((s20 - s50) / s50 / 0.02), -1, 1);
  const volPct = (a / price) * 100;
  const regime: Regime =
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
    // sim close-out window (used ONLY by simOutcome() — agents never see it)
    _forward: bars.slice(used),
  };
}

export function simOutcome(snap: Snapshot, decision: Decision | AgentAction, sizePct: number, horizon: number = 20) {
  const f = snap._forward.slice(0, horizon);
  if (f.length === 0) return { realizedPct: 0, simClosed: true };
  const entry = snap.price;
  const exit = f[f.length - 1].c;
  const movePct = ((exit - entry) / entry) * 100;
  const dir = decision === "buy" ? 1 : decision === "sell" ? -1 : 0;
  const frac = sizePct / 100;
  return { realizedPct: round4(movePct * dir * frac), simClosed: true };
}

// ---- real-bars input (R359) ---------------------------------------------------
// Faithful port of repos/saos-desk/src/kernel.mjs (source of truth).
// The kernel DECIDES ON MEASURED BARS; genSeries/snapshot() are selftest fixtures
// only (law #14). Fail-closed: any structural violation THROWS — never repaired,
// never synthesized. Same bars -> same beat (determinism preserved).

export function validateBars(bars: unknown, opts: { minBars?: number } = {}): true {
  const minBars = opts.minBars ?? 1;
  if (!Array.isArray(bars)) throw new Error("bars-not-array");
  if (bars.length < minBars) throw new Error(`bars-too-few:${bars.length}`);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] as Partial<Bar> | null | undefined;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error(`bar-${i}-not-object`);
    for (const k of ["o", "h", "l", "c"] as const) {
      const v = b[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new Error(`bar-${i}-${k}-not-positive-finite`);
      }
    }
    if ((b.h as number) < (b.l as number)) throw new Error(`bar-${i}-high-below-low`);
    if ((b.h as number) < (b.o as number) || (b.h as number) < (b.c as number) || (b.l as number) > (b.o as number) || (b.l as number) > (b.c as number)) {
      throw new Error(`bar-${i}-ohlc-inconsistent`);
    }
  }
  return true;
}

// Indicator block kept in lockstep with snapshot() — the engine repo's selftest
// proves bit-identity between the two paths (vector 11.1); keep this port identical.
export function snapshotFromBars(symbol: string, klass: string, bars: Bar[], opts: { used?: number; forwardMax?: number } = {}): Snapshot {
  const used = opts.used ?? 120;
  const forwardMax = opts.forwardMax ?? 5;
  validateBars(bars, { minBars: used });
  const window = bars.slice(-(used + forwardMax));
  const seen = window.slice(0, used);
  const forward = window.slice(used); // REAL next-bars (0..forwardMax) — agents never see them
  const closes = seen.map((b) => b.c);
  const price = closes[closes.length - 1];
  const a = atr(seen, 14) ?? price * 0.01;
  const s20 = sma(closes, 20) ?? price;
  const s50 = sma(closes, 50) ?? price;
  const trendScore = clamp(Math.tanh((s20 - s50) / s50 / 0.02), -1, 1);
  const volPct = (a / price) * 100;
  const regime: Regime =
    Math.abs(trendScore) > 0.45
      ? trendScore > 0 ? "trend-up" : "trend-down"
      : volPct > 2.0 ? "choppy-highvol" : "choppy-lowvol";
  return {
    seed: null, // no seed: the market generated these bars, not a PRNG
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
    source: "live-bars",
    _forward: forward,
  };
}

// Measured outcome on REAL next-bars (R359). No forward bar yet = pending:
// honest zeros everywhere — evolve() yields factor 1 (weights untouched).
export function realOutcome(snap: Snapshot, decision: Decision | AgentAction, sizePct: number): Outcome {
  const f = Array.isArray(snap._forward) ? snap._forward : [];
  if (f.length === 0) {
    return { realizedPct: 0, simClosed: false, pending: true, outcomeSource: "awaiting-next-real-bar" };
  }
  const entry = snap.price;
  const exit = f[f.length - 1].c;
  const movePct = ((exit - entry) / entry) * 100;
  const dir = decision === "buy" ? 1 : decision === "sell" ? -1 : 0;
  const frac = sizePct / 100;
  return {
    realizedPct: round4(movePct * dir * frac),
    simClosed: false,
    pending: false,
    outcomeSource: "measured-next-bar",
  };
}

// ---- canonical signature (8 hex of sha256 over canonical JSON) ---------------
// Contract: payload WITHOUT the signature field (T-88 law).
export function canonical(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj) ?? "null";
  if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(rec[k])).join(",") + "}";
}

export function sig8(payloadWithoutSig: unknown): string {
  return createHash("sha256").update(canonical(payloadWithoutSig)).digest("hex").slice(0, 8);
}

// ---- agents — the cabinet specialists ----------------------------------------
// roster lives in mandate.ts (client-safe single source of truth)
export { AGENTS };

export const AGENT_IDS: AgentId[] = AGENTS.map((a) => a.id);

export function seedWeights(): Weights {
  const w: Weights = {};
  for (const id of AGENT_IDS) {
    w[id] = { weight: 1, wins: 0, losses: 0 };
  }
  return w;
}

export function verdict(agentId: AgentId, snap: Snapshot, mandate: Mandate, weights: Weights | null): Verdict {
  const weight = weights?.[agentId]?.weight ?? 1;
  const L = mandate.limits;
  switch (agentId) {
    case "technical": {
      const reasons: string[] = [];
      const r = snap.rsi14;
      const above = snap.price >= snap.sma50;
      reasons.push(`RSI14=${r} · מחיר ${above ? "מעל" : "מתחת"} SMA50=${snap.sma50} · מגמה=${snap.trendScore}`);
      if (r <= 30 && above) return { agentId, name: "הטכני", action: "buy", confidence: clamp(0.55 + (30 - r) / 100 + Math.abs(snap.trendScore) * 0.2, 0, 1), reasons, weight };
      if (r >= 70 && !above) return { agentId, name: "הטכני", action: "sell", confidence: clamp(0.55 + (r - 70) / 100 + Math.abs(snap.trendScore) * 0.2, 0, 1), reasons, weight };
      if (snap.trendScore >= 0.45) return { agentId, name: "הטכני", action: "buy", confidence: 0.5 + snap.trendScore * 0.2, reasons, weight };
      if (snap.trendScore <= -0.45) return { agentId, name: "הטכני", action: "sell", confidence: 0.5 + Math.abs(snap.trendScore) * 0.2, reasons, weight };
      return { agentId, name: "הטכני", action: "hold", confidence: 0.5, reasons, weight };
    }
    case "valuation": {
      const mid = (snap.sma20 + snap.sma50) / 2;
      const z = snap.volPct > 0 ? (snap.price - mid) / (snap.atr14 * 2) : 0; // price in ATR units from fair band
      const reasons = [`מחיר ${snap.price} מול פס-הוגן ${round4(mid)} (z=${round4(z)})`];
      if (z <= -1) return { agentId, name: "הערכת-השווי", action: "buy", confidence: clamp(0.5 + Math.min(0.3, -z * 0.2), 0, 1), reasons, weight };
      if (z >= 1) return { agentId, name: "הערכת-השווי", action: "sell", confidence: clamp(0.5 + Math.min(0.3, z * 0.2), 0, 1), reasons, weight };
      return { agentId, name: "הערכת-השווי", action: "hold", confidence: 0.5, reasons, weight };
    }
    case "momentum": {
      const c = snap.bars.map((b) => b.c);
      const n = c.length;
      const r10 = n >= 11 ? (c[n - 1] / c[n - 11] - 1) * 100 : 0;
      const reasons = [`תשואה 10-נרות=${round4(r10)}% · משטר=${snap.regime}`];
      if (r10 >= 3 && snap.regime !== "choppy-highvol") return { agentId, name: "המומנטום", action: "buy", confidence: clamp(0.5 + Math.min(0.35, r10 / 20), 0, 1), reasons, weight };
      if (r10 <= -3 && snap.regime !== "choppy-highvol") return { agentId, name: "המומנטום", action: "sell", confidence: clamp(0.5 + Math.min(0.35, -r10 / 20), 0, 1), reasons, weight };
      return { agentId, name: "המומנטום", action: "hold", confidence: 0.5, reasons, weight };
    }
    case "sentiment": {
      // deterministic pseudo-sentiment per (symbol, seed) — HONEST: sim only here.
      const s = ((hash32(snap.symbol + "|" + snap.seed) % 201) - 100) / 100;
      const reasons = [`ציון-סנטימנט (סימולציה)=${round4(s)} · ערוצי-עברית: ${mandate.hebrewFeeds.map((f) => f.name).join(", ")}`];
      if (s >= 0.25) return { agentId, name: "הסנטימנט", action: "buy", confidence: 0.4 + 0.3 * s, reasons, weight };
      if (s <= -0.25) return { agentId, name: "הסנטימנט", action: "sell", confidence: 0.4 + 0.3 * Math.abs(s), reasons, weight };
      return { agentId, name: "הסנטימנט", action: "hold", confidence: 0.45, reasons, weight };
    }
    case "risk": {
      const reasons: string[] = [];
      if (snap.volPct > L.volHaltPct) {
        reasons.push(`תנודתיות ${snap.volPct}% מעל סף ${L.volHaltPct}% — וטו-חשיפה`);
        return { agentId, name: "הסיכונים", action: "sell", confidence: 0.8, reasons, weight };
      }
      if (Math.abs(snap.trendScore) < 0.15) {
        reasons.push(`אין כיוון (מגמה=${snap.trendScore}) — מומלץ הימנעות`);
        return { agentId, name: "הסיכונים", action: "hold", confidence: 0.6, reasons, weight };
      }
      if (snap.trendScore <= -0.45) {
        reasons.push("מגמה יורדת חדה — הגנה בצד הקצר");
        return { agentId, name: "הסיכונים", action: "sell", confidence: 0.55, reasons, weight };
      }
      reasons.push(`תנודתיות ${snap.volPct}% בתוך הסף · מגמה=${snap.trendScore}`);
      return { agentId, name: "הסיכונים", action: snap.trendScore >= 0.45 ? "buy" : "hold", confidence: 0.5 + Math.max(0, snap.trendScore) * 0.2, reasons, weight };
    }
    default:
      return { agentId, name: agentId, action: "hold", confidence: 0.5, reasons: [], weight };
  }
}

export function cabinet(snap: Snapshot, mandate: Mandate, weights: Weights | null): Verdict[] {
  return AGENTS.map((a) => verdict(a.id, snap, mandate, weights));
}

// ---- boardroom — the cabinet debate, chair, and risk gate --------------------
const ACTIONS: AgentAction[] = ["buy", "hold", "sell"];

// weighted score of an action over verdicts (raw sum, not normalized — the quorum law is absolute)
function score(verdicts: Verdict[], action: AgentAction): number {
  let s = 0, total = 0;
  for (const v of verdicts) { total += v.weight * v.confidence; if (v.action === action) s += v.weight * v.confidence; }
  return total === 0 ? 0 : s / 1;
}

export function weightedConf(verdicts: Verdict[], action: AgentAction): number {
  const same = verdicts.filter((v) => v.action === action);
  if (same.length === 0) return 0;
  const wsum = same.reduce((a, v) => a + v.weight, 0);
  if (wsum === 0) return 0;
  return same.reduce((a, v) => a + v.weight * v.confidence, 0) / wsum;
}

export function weightedMajority(verdicts: Verdict[]): { action: AgentAction; score: number } {
  let best: AgentAction = "hold", bestScore = -1;
  for (const a of ACTIONS) {
    const s = score(verdicts, a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return { action: best, score: round4(bestScore) };
}

// 3-round deterministic debate: undecided agents (conf<0.6) converge to the
// weighted majority by at most +0.05 confidence per round; decided agents hold.
export function debate(verdicts0: Verdict[], rounds: number = 3): { verdicts: Verdict[]; log: DebateRound[] } {
  const log: DebateRound[] = [];
  const verdicts = verdicts0.map((v) => ({ ...v, reasons: [...v.reasons] }));
  for (let r = 1; r <= rounds; r++) {
    const maj = weightedMajority(verdicts);
    const statements = verdicts.map((v) => {
      if (v.confidence < 0.6 && v.action !== maj.action && maj.score >= 0.25) {
        v.action = maj.action;
        v.confidence = clamp(v.confidence + 0.05, 0, 1);
        return { agentId: v.agentId, stance: v.action, argument: `מתעדכן בסבב ${r}: הקונצנזוס המשוקלל = ${maj.action} (מדד=${maj.score})` };
      }
      return { agentId: v.agentId, stance: v.action, argument: `מחזיק עמדה (סבב ${r})` };
    });
    log.push({ round: r, statements });
  }
  return { verdicts, log };
}

export function computeDrawdown(equityPctList: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const r of equityPctList) {
    cum += r;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

export function riskGate(
  snap: Snapshot,
  mandate: Mandate,
  _chairAction: AgentAction | Decision,
  sizePct: number,
  kellyF: number,
  state?: { equity?: number[] } | null
): RiskGateResult {
  const L = mandate.limits;
  const inUniverse =
    mandate.universe.tase.includes(snap.symbol) || mandate.universe.global.includes(snap.symbol);
  const liveBlocked = mandate.execution.mode === "live" && !mandate.execution.liveOwnerArmed;
  const drawdown = state?.equity?.length ? computeDrawdown(state.equity) : 0;
  const checks = [
    { id: "G1", label: "הסמל באוניברס המנדט", passed: inUniverse, measured: snap.symbol, limit: "universe.tase ∪ universe.global" },
    { id: "G2", label: "מצב-ביצוע חוקי", passed: !liveBlocked, measured: mandate.execution.mode, limit: mandate.execution.mode === "live" ? "דורש הצטיידות דו-מפתחות של הבעלים" : "paper" },
    { id: "G3", label: "גודל עמדה ≤ מרבי", passed: sizePct <= L.maxPositionPct, measured: `${sizePct}%`, limit: `${L.maxPositionPct}%` },
    { id: "G4", label: "שבר-קלי ≤ תקרה", passed: kellyF <= L.kellyCap, measured: `${round4(kellyF)}`, limit: `${L.kellyCap}` },
    { id: "G5", label: "תנודתיות ≤ סף-עצירה", passed: snap.volPct <= L.volHaltPct, measured: `${snap.volPct}%`, limit: `${L.volHaltPct}%` },
    { id: "G6", label: "דריידאון ≤ הפסקה", passed: drawdown <= L.drawdownHaltPct, measured: `${round4(drawdown)}%`, limit: `${L.drawdownHaltPct}%` },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

export function chair(
  snap: Snapshot,
  mandate: Mandate,
  verdicts: Verdict[],
  state?: { equity?: number[] } | null
) {
  const Q = mandate.quorum;
  const maj = weightedMajority(verdicts);
  const wconf = weightedConf(verdicts, maj.action);
  const quorumPassed = maj.score >= Q.minWeightedScore && wconf >= Q.minConfidence;
  const dirAction = maj.action === "buy" || maj.action === "sell" ? maj.action : null;
  const f = dirAction ? clamp(2 * (wconf - 0.5), 0, 1) * mandate.limits.kellyCap : 0;
  const sizePct = dirAction ? round4(Math.min(mandate.limits.maxPositionPct, f * mandate.limits.maxPositionPct)) : 0;
  const gate = riskGate(snap, mandate, maj.action, sizePct, f, state);
  const decided = dirAction !== null && quorumPassed && gate.passed;
  const notes = [
    `מדד-רוב משוקלל=${maj.score} (נדרש ≥${Q.minWeightedScore}) · ביטחון משוקלל=${round4(wconf)} (נדרש ≥${Q.minConfidence})`,
    quorumPassed ? "הקוורום עובר" : "הקוורום נכשל — היו\"ר מציב שטוח",
  ];
  if (dirAction && !gate.passed) notes.push("שער-הסיכון מטיל וטו — אין פוזיציה");
  return {
    decision: decided ? dirAction : "flat",
    sizePct: decided ? sizePct : 0,
    confidence: round4(wconf),
    quorumPassed,
    notes,
    _kellyF: round4(f),
    _riskGate: gate,
  } as const;
}

export function runBoardroom(snap: Snapshot, mandate: Mandate, verdicts0: Verdict[], state?: { equity?: number[] } | null) {
  const { verdicts, log } = debate(verdicts0, mandate.quorum.rounds);
  const c = chair(snap, mandate, verdicts, state);
  const { _kellyF, _riskGate, ...publicChair } = c;
  return {
    agents: verdicts,
    debate: log,
    chair: publicChair,
    riskGate: _riskGate,
    sig: sig8({ symbol: snap.symbol, seed: snap.seed, chair: publicChair, agents: verdicts.map((v) => ({ a: v.agentId, act: v.action, cf: v.confidence })) }),
  };
}

// ---- reflexivity — Darwinian weight evolution --------------------------------
// Agents aligned with a profitable decision gain; aligned with a losing one lose.
// Unaligned agents (hold/flat or direction-neutral) stay untouched — honest zeros.
export function evolve(weights0: Weights, agents: Verdict[], decision: Decision, sizePct: number, realizedPct: number): { weights: Weights; perAgent: WeightDelta[] } {
  const weights: Weights = JSON.parse(JSON.stringify(weights0));
  const frac = sizePct / 100;
  const tradePnl = frac > 0 ? realizedPct / frac : 0; // per-unit-of-position return
  const perAgent: WeightDelta[] = [];
  for (const v of agents) {
    const w0 = weights[v.agentId]?.weight ?? 1;
    const entry: AgentWeightEntry = weights[v.agentId] ?? { weight: w0, wins: 0, losses: 0 };
    const aligned = v.action === decision && (decision === "buy" || decision === "sell");
    let pnl = 0;
    if (aligned && frac > 0) {
      // buy-aligned agents earn tradePnl; sell-aligned agents earn the short side (-tradePnl)
      pnl = v.action === "buy" ? tradePnl : -tradePnl;
    }
    const factor = 1 + 0.25 * Math.tanh(4 * pnl);
    const w1 = clamp(w0 * factor, 0.5, 2.0);
    entry.weight = round4(w1);
    if (pnl > 0.001) entry.wins += 1;
    else if (pnl < -0.001) entry.losses += 1;
    weights[v.agentId] = entry;
    perAgent.push({ agentId: v.agentId, aligned, pnl: round4(pnl), factor: round4(factor), weightBefore: w0, weightAfter: entry.weight });
  }
  return { weights, perAgent };
}

// ---- one desk beat, end-to-end (pure) ----------------------------------------
// beat = snapshot -> cabinet -> boardroom -> outcome(sim) -> reflexivity -> artifact
// Mirrors repos/saos-desk/src/cycle.mjs runBeat(), with prevSig/sig applied like
// checkpoint.mjs appendLedger() (sig = sig8 over the entry WITHOUT the sig field).
export interface PureBeatInput {
  seed: number;
  symbol: string;
  klass: string;
  mandate: Mandate;
  beat: number;
  weights: Weights;
  equity: number[];
  prevSig: string;
  wallClock: string | null;
  /** R359: when present, the kernel decides on these MEASURED bars (law #14) */
  realBars?: Bar[] | null;
}

export function runBeatPure(input: PureBeatInput): { entry: DeskArtifact; evolvedWeights: Weights } {
  const { seed, symbol, klass, mandate, beat, weights, equity, prevSig, wallClock, realBars } = input;
  const snap = realBars
    ? snapshotFromBars(symbol, klass, realBars, {
        used: mandate.marketData?.decisionBars ?? 120,
        forwardMax: mandate.marketData?.forwardMax ?? 5,
      })
    : snapshot(seed, symbol, klass);
  const verdicts = cabinet(snap, mandate, weights);
  const board = runBoardroom(snap, mandate, verdicts, { equity });
  const outcome = realBars
    ? realOutcome(snap, board.chair.decision, board.chair.sizePct)
    : simOutcome(snap, board.chair.decision, board.chair.sizePct);
  const evolved = evolve(weights, board.agents, board.chair.decision, board.chair.sizePct, outcome.realizedPct);

  const artifact: DeskArtifact = {
    schema: "saos-desk/session@1",
    seed,
    beat,
    symbol: snap.symbol,
    klass: snap.klass,
    regime: snap.regime,
    market: {
      price: snap.price, atr14: snap.atr14, rsi14: snap.rsi14,
      sma20: snap.sma20, sma50: snap.sma50, trendScore: snap.trendScore,
      volPct: snap.volPct, source: snap.source,
      bars: snap.bars.map((b) => [b.o, b.h, b.l, b.c]),
    },
    dataMode: realBars ? "live-bars" : "sim",
    agents: board.agents,
    debate: board.debate,
    chair: board.chair,
    riskGate: board.riskGate,
    outcome,
    weightsAfter: evolved.perAgent,
    mandate: {
      execution: mandate.execution.mode,
      maxPositionPct: mandate.limits.maxPositionPct,
      volHaltPct: mandate.limits.volHaltPct,
    },
    at: wallClock,
  };

  const entry: DeskArtifact = { ...artifact, prevSig };
  entry.sig = sig8({ ...entry, sig: undefined });
  return { entry, evolvedWeights: evolved.weights };
}

// deterministic per-beat seed (session route contract):
// seed = (1000003 * beat + hash32(symbol)) % 2147483647
export function deriveSeed(beat: number, symbol: string): number {
  return (1000003 * beat + hash32(symbol)) % 2147483647;
}

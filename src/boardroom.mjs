// saos-desk boardroom — the cabinet debate, chair, and risk gate (R338)
// Pure. The math is deterministic; the mandate is the hard law.
import { clamp, round4, sig8 } from "./kernel.mjs";

const ACTIONS = ["buy", "hold", "sell"];

// weighted score of an action over verdicts
function score(verdicts, action) {
  let s = 0, total = 0;
  for (const v of verdicts) { total += v.weight * v.confidence; if (v.action === action) s += v.weight * v.confidence; }
  return total === 0 ? 0 : s / 1; // raw sum, not normalized — the quorum law is absolute
}

export function weightedConf(verdicts, action) {
  const same = verdicts.filter((v) => v.action === action);
  if (same.length === 0) return 0;
  const wsum = same.reduce((a, v) => a + v.weight, 0);
  if (wsum === 0) return 0;
  return same.reduce((a, v) => a + v.weight * v.confidence, 0) / wsum;
}

export function weightedMajority(verdicts) {
  let best = "hold", bestScore = -1;
  for (const a of ACTIONS) {
    const s = score(verdicts, a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return { action: best, score: round4(bestScore) };
}

// 3-round deterministic debate: undecided agents (conf<0.6) converge to the
// weighted majority by at most +0.05 confidence per round; decided agents hold.
export function debate(verdicts0, rounds = 3) {
  const log = [];
  let verdicts = verdicts0.map((v) => ({ ...v, reasons: [...v.reasons] }));
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

export function riskGate(snap, mandate, chairAction, sizePct, kellyF, state) {
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

export function computeDrawdown(equityPctList) {
  let cum = 0, peak = 0, dd = 0;
  for (const r of equityPctList) {
    cum += r;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

export function chair(snap, mandate, verdicts, state) {
  const Q = mandate.quorum;
  const maj = weightedMajority(verdicts);
  const wconf = weightedConf(verdicts, maj.action);
  const quorumPassed = maj.score >= Q.minWeightedScore && wconf >= Q.minConfidence;
  const dirAction = maj.action === "buy" || maj.action === "sell" ? maj.action : null;
  const f = dirAction ? clamp(2 * (wconf - 0.5), 0, 1) * mandate.limits.kellyCap : 0;
  const sizePct = dirAction ? round4(Math.min(mandate.limits.maxPositionPct, f * mandate.limits.maxPositionPct)) : 0;
  const gate = riskGate(snap, mandate, maj.action, sizePct, f, state);
  const decided = dirAction && quorumPassed && gate.passed;
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
  };
}

export function runBoardroom(snap, mandate, verdicts0, state) {
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

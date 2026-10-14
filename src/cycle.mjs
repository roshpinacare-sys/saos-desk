// saos-desk cycle — one desk beat end-to-end (R338)
// beat = snapshot -> cabinet -> boardroom -> outcome(sim) -> reflexivity -> checkpoint
// Paper-only by mandate; live execution is owner-gated and ABSENT (zero keys).
import fs from "node:fs";
import { snapshot, simOutcome } from "./kernel.mjs";
import { cabinet } from "./agents.mjs";
import { runBoardroom } from "./boardroom.mjs";
import { evolve } from "./reflexivity.mjs";
import { loadState, appendLedger, saveSnapshot, resumeCheck, verifyLedger } from "./checkpoint.mjs";

export function seedWeights() {
  const w = {};
  for (const id of ["technical", "valuation", "momentum", "sentiment", "risk"]) {
    w[id] = { weight: 1, wins: 0, losses: 0 };
  }
  return w;
}

export function runBeat({ seed, symbol, klass = "tase", mandate, stateDir, snapFn = null, wallClock = null }) {
  const resume = resumeCheck(stateDir);
  if (!resume.ok) {
    return { ok: false, error: "RESUME-CHECK-FAILED", resume };
  }
  const state = loadState(stateDir, seedWeights());
  let snap;
  try {
    snap = snapFn ? snapFn(seed, symbol) : snapshot(seed, symbol, klass);
  } catch (e) {
    return { ok: false, error: "SNAPSHOT-FAILED", reason: String(e?.message ?? e) };
  }
  const verdicts = cabinet(snap, mandate, state.weights);
  const board = runBoardroom(snap, mandate, verdicts, state);
  const outcome = simOutcome(snap, board.chair.decision, board.chair.sizePct);
  const evolved = evolve(state.weights, board.agents, board.chair.decision, board.chair.sizePct, outcome.realizedPct);

  const artifact = {
    schema: "saos-desk/session@1",
    seed,
    beat: state.beat + 1,
    symbol: snap.symbol,
    klass: snap.klass,
    regime: snap.regime,
    market: {
      price: snap.price, atr14: snap.atr14, rsi14: snap.rsi14,
      sma20: snap.sma20, sma50: snap.sma50, trendScore: snap.trendScore,
      volPct: snap.volPct, source: snap.source,
      bars: snap.bars.map((b) => [b.o, b.h, b.l, b.c]),
    },
    dataMode: snapFn ? "live-probe" : "sim",
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
    at: wallClock ?? null,
  };

  const entry = appendLedger(stateDir, artifact);
  const equity = [...state.equity, outcome.realizedPct];
  const newState = {
    beat: entry.beat,
    chainHead: entry.sig,
    head: entry.sig,
    equity,
    weights: evolved.weights,
  };
  saveSnapshot(stateDir, newState);
  return { ok: true, artifact: entry, state: newState };
}

export function deskStatus(stateDir, mandate) {
  const v = verifyLedger(stateDir);
  const resume = resumeCheck(stateDir);
  let state = null;
  const sp = `${stateDir}/beat.json`;
  if (fs.existsSync(sp)) state = JSON.parse(fs.readFileSync(sp, "utf8"));
  return {
    execution: mandate.execution.mode,
    liveOwnerArmed: mandate.execution.liveOwnerArmed,
    universe: mandate.universe,
    feeds: mandate.hebrewFeeds.map((f) => f.name),
    limits: mandate.limits,
    ledger: v,
    resume,
    beat: state?.beat ?? 0,
    chainHead: state?.chainHead ?? null,
    weights: state?.weights ?? seedWeights(),
    equity: state?.equity ?? [],
  };
}

// CLI: bun src/cycle.mjs <seed> <symbol> [stateDir]
const isMain = process.argv[1] && process.argv[1].endsWith("cycle.mjs");
if (isMain) {
  const seed = Number(process.argv[2] ?? 7);
  const symbol = process.argv[3] ?? "LEUMI.TA";
  const mandate = JSON.parse(fs.readFileSync(new URL("../mandate.json", import.meta.url), "utf8"));
  const stateDir = process.argv[4] ?? new URL("../state", import.meta.url).pathname;
  const r = runBeat({ seed, symbol, mandate, stateDir, wallClock: new Date().toISOString() });
  console.log(JSON.stringify(r.ok ? { sig: r.artifact.sig, beat: r.artifact.beat, decision: r.artifact.chair.decision, sizePct: r.artifact.chair.sizePct, realizedPct: r.artifact.outcome.realizedPct } : r, null, 2));
}

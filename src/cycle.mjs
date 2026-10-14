// saos-desk cycle — one desk beat end-to-end (R338, R345 feed gate, R353 real-bars input)
// beat = snapshot -> cabinet -> boardroom -> [feed gate R345] -> outcome(measured|sim) -> reflexivity -> checkpoint
// Paper-only by mandate; live execution is owner-gated and ABSENT (zero keys).
// R345: a REFRAIN feed verdict forces the chair flat — observation-only, fail-closed.
// R353: realBars present -> the kernel decides on MEASURED bars (law #14); the sim
// path survives for selftest fixtures only. Pending outcome = honest zeros, never fabricated.
import fs from "node:fs";
import { snapshot, simOutcome, snapshotFromBars, realOutcome } from "./kernel.mjs";
import { cabinet } from "./agents.mjs";
import { runBoardroom } from "./boardroom.mjs";
import { guardedChair } from "./ingest.mjs";
import { evolve } from "./reflexivity.mjs";
import { loadState, appendLedger, saveSnapshot, resumeCheck, verifyLedger } from "./checkpoint.mjs";
import { loadFeedState } from "./fetch-live.mjs";

export function seedWeights() {
  const w = {};
  for (const id of ["technical", "valuation", "momentum", "sentiment", "risk"]) {
    w[id] = { weight: 1, wins: 0, losses: 0 };
  }
  return w;
}

export function runBeat({ seed, symbol, klass = "tase", mandate, stateDir, snapFn = null, wallClock = null, feedAssessment = null, realBars = null }) {
  const resume = resumeCheck(stateDir);
  if (!resume.ok) {
    return { ok: false, error: "RESUME-CHECK-FAILED", resume };
  }
  const state = loadState(stateDir, seedWeights());
  let snap;
  try {
    snap = snapFn
      ? snapFn(seed, symbol)
      : realBars
        ? snapshotFromBars(symbol, klass, realBars, {
            used: mandate.marketData?.decisionBars ?? 120,
            forwardMax: mandate.marketData?.forwardMax ?? 5,
          })
        : snapshot(seed, symbol, klass);
  } catch (e) {
    return { ok: false, error: "SNAPSHOT-FAILED", reason: String(e?.message ?? e) };
  }
  const verdicts = cabinet(snap, mandate, state.weights);
  const board0 = runBoardroom(snap, mandate, verdicts, state);
  const board = guardedChair(board0, feedAssessment);
  const outcome = (realBars && !snapFn)
    ? realOutcome(snap, board.chair.decision, board.chair.sizePct)
    : simOutcome(snap, board.chair.decision, board.chair.sizePct);
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
    dataMode: snapFn ? "live-probe" : realBars ? "live-bars" : "sim",
    feed: {
      verdict: feedAssessment?.verdict ?? "UNPROBED",
      refrain: board.refrain === true,
      reason: board.refrain === true ? (feedAssessment?.reasons ?? ["REFRAIN"]).join(" · ") : null,
    },
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
    feed: loadFeedState(stateDir, Date.now(), { maxAgeMin: mandate.ingest?.freshnessMaxMin ?? 90 }),
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
  // R345: the beat consults the sealed feed state — stale/tampered/dead artery = REFRAIN
  const feed = loadFeedState(stateDir, Date.now(), { maxAgeMin: mandate.ingest?.freshnessMaxMin ?? 90 });
  const feedAssessment = feed.ok ? feed.assessment : { verdict: "REFRAIN", reasons: [feed.reason ?? "feed-state-unavailable"] };
  const r = runBeat({ seed, symbol, mandate, stateDir, wallClock: new Date().toISOString(), feedAssessment });
  console.log(JSON.stringify(r.ok ? { sig: r.artifact.sig, beat: r.artifact.beat, decision: r.artifact.chair.decision, sizePct: r.artifact.chair.sizePct, realizedPct: r.artifact.outcome.realizedPct, feed: r.artifact.feed } : r, null, 2));
}

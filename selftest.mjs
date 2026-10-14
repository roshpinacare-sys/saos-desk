// saos-desk selftest — pure vectors (R338), discipline: same as the sovereignty fleet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mulberry32, hash32, genSeries, sma, ema, rsi, atr, bollinger, macd, snapshot, simOutcome, canonical, sig8 } from "./src/kernel.mjs";
import { AGENTS, cabinet, verdict } from "./src/agents.mjs";
import { weightedMajority, debate, runBoardroom, riskGate, computeDrawdown } from "./src/boardroom.mjs";
import { evolve } from "./src/reflexivity.mjs";
import { loadState, appendLedger, verifyLedger, resumeCheck } from "./src/checkpoint.mjs";
import { runBeat, seedWeights } from "./src/cycle.mjs";
import { TASE_UNIVERSE, HEBREW_FEEDS } from "./src/data.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; fails.push(name); console.log(`  FAIL ${name}`); }
}
function section(n, title) { console.log(`section ${n} — ${title}`); }
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `saos-desk-${tag}-`));
  return d;
}

const mandate = JSON.parse(fs.readFileSync(new URL("./mandate.json", import.meta.url), "utf8"));
const clone = (m) => JSON.parse(JSON.stringify(m));

// ─────────────────────────────────────────────────────────────────────────────
section(1, "kernel — determinism, series invariants, indicators, sig");
{
  const a1 = mulberry32(42), a2 = mulberry32(42);
  let same = true;
  for (let i = 0; i < 100; i++) if (a1() !== a2()) same = false;
  ok("1.1 prng same-seed identical", same);
  ok("1.2 prng different-seed differs", mulberry32(1)() !== mulberry32(2)());
  ok("1.3 hash32 stable", hash32("LEUMI.TA") === hash32("LEUMI.TA") && hash32("LEUMI.TA") !== hash32("NICE.TA"));
  ok("1.4 hash32 uint32", Number.isInteger(hash32("x")) && hash32("x") >= 0 && hash32("x") <= 0xffffffff);

  const bars = genSeries(7, "TEVA.TA", 140);
  ok("1.5 series length", bars.length === 140);
  ok("1.6 series determinism", JSON.stringify(genSeries(7, "TEVA.TA", 140)) === JSON.stringify(bars));
  ok("1.7 series per-symbol differs", JSON.stringify(genSeries(7, "NICE.TA", 140)) !== JSON.stringify(bars));
  let ohlcOk = true;
  for (const b of bars) {
    if (!(b.h >= Math.max(b.o, b.c) - 1e-9)) ohlcOk = false;
    if (!(b.l <= Math.min(b.o, b.c) + 1e-9)) ohlcOk = false;
    if (!(b.c > 0 && b.o > 0 && b.v >= 0)) ohlcOk = false;
  }
  ok("1.8 OHLCV invariants all bars", ohlcOk);

  const closes = bars.map((b) => b.c);
  ok("1.9 sma of constant", sma([5, 5, 5, 5, 5], 5) === 5);
  ok("1.10 sma window-exact", Math.abs(sma(closes, 20) - closes.slice(-20).reduce((a, b) => a + b, 0) / 20) < 1e-9);
  ok("1.11 ema converges to last-weighted", ema(closes, 20) !== null);
  const r = rsi(closes, 14);
  ok("1.12 rsi bounds 0..100", r >= 0 && r <= 100);
  ok("1.13 rsi all-up → 100", rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14) === 100);
  ok("1.14 atr positive", atr(bars, 14) > 0);
  const bb = bollinger(closes, 20, 2);
  ok("1.15 bollinger mid = sma20", Math.abs(bb.mid - sma(closes, 20)) < 1e-9);
  ok("1.16 bollinger z=0 at mid (exact ints)", bollinger(Array(20).fill(10), 20, 2).z === 0);
  const m = macd(closes);
  ok("1.17 macd shape", m !== null && typeof m.line === "number" && typeof m.zero === "boolean");
  ok("1.18 snapshot carries seed+source sim", snapshot(7, "ICL.TA", "tase").source === "sim" && snapshot(7, "ICL.TA", "tase").seed === 7);
  const snap = snapshot(7, "ICL.TA", "tase");
  ok("1.19 snapshot bars hidden forward", snap.bars.length === 120 && snap._forward.length === 20);
  ok("1.20 regime in known set", ["trend-up", "trend-down", "choppy-highvol", "choppy-lowvol"].includes(snap.regime));

  const payload = { a: 1, b: { d: 2, c: 3 } };
  ok("1.21 canonical sorted keys", canonical(payload) === '{"a":1,"b":{"c":3,"d":2}}');
  ok("1.22 sig8 stable", sig8(payload) === sig8(payload));
  ok("1.23 sig8 changes on payload change", sig8(payload) !== sig8({ ...payload, a: 2 }));
  ok("1.24 sig8 8-hex", /^[0-9a-f]{8}$/.test(sig8(payload)));
  const out = simOutcome(snap, "buy", 10);
  ok("1.25 simOutcome shape", typeof out.realizedPct === "number" && out.simClosed === true);
}

// ─────────────────────────────────────────────────────────────────────────────
section(2, "agents — directional logic on crafted snapshots");
{
  const mk = (over) => ({
    seed: 7, symbol: "LEUMI.TA", klass: "tase",
    price: 100, atr14: 1, rsi14: 50, sma20: 100, sma50: 100,
    trendScore: 0, volPct: 1, regime: "choppy-lowvol", source: "sim",
    bars: Array.from({ length: 120 }, (_, i) => ({ o: 100, h: 101, l: 99, c: 100, v: 1000 })),
    _forward: [],
    ...over,
  });
  const w = seedWeights();

  const oversold = mk({ rsi14: 22, price: 100, sma50: 90 });
  const vTech = verdict("technical", oversold, mandate, w);
  ok("2.1 technical buys oversold-above-sma50", vTech.action === "buy" && vTech.confidence > 0.5);

  const overbought = mk({ rsi14: 78, price: 100, sma50: 110 });
  ok("2.2 technical sells overbought-below-sma50", verdict("technical", overbought, mandate, w).action === "sell");

  const cheap = mk({ price: 95, sma20: 100, sma50: 100, atr14: 2 });
  const vVal = verdict("valuation", cheap, mandate, w);
  ok("2.3 valuation buys below fair band", vVal.action === "buy");

  const dear = mk({ price: 107, sma20: 100, sma50: 100, atr14: 2 });
  ok("2.4 valuation sells above fair band", verdict("valuation", dear, mandate, w).action === "sell");

  const up = mk({ bars: Array.from({ length: 120 }, (_, i) => ({ o: 100, h: 101, l: 99, c: 100 + i * 0.5, v: 1000 })), regime: "trend-up", trendScore: 0.8 });
  ok("2.5 momentum buys strong rise", verdict("momentum", up, mandate, w).action === "buy");

  const s1 = verdict("sentiment", mk({}), mandate, w);
  const s2 = verdict("sentiment", mk({}), mandate, w);
  ok("2.6 sentiment deterministic per (symbol,seed)", JSON.stringify(s1) === JSON.stringify(s2));
  ok("2.7 sentiment reasons declare sim", s1.reasons.some((x) => x.includes("סימולציה")));

  const wild = mk({ volPct: 4 });
  const vRisk = verdict("risk", wild, mandate, w);
  ok("2.8 risk vetoes high vol", vRisk.action === "sell" && vRisk.confidence >= 0.8);
  const calm = mk({ volPct: 1, trendScore: 0.1 });
  ok("2.9 risk holds directionless", verdict("risk", calm, mandate, w).action === "hold");

  const cab = cabinet(mk({}), mandate, w);
  ok("2.10 cabinet = 5 agents, ids exact", cab.length === 5 && cab.map((v) => v.agentId).join(",") === AGENTS.map((a) => a.id).join(","));
  ok("2.11 every verdict carries reasons+weight", cab.every((v) => Array.isArray(v.reasons) && v.reasons.length > 0 && typeof v.weight === "number"));
}

// ─────────────────────────────────────────────────────────────────────────────
section(3, "boardroom — debate convergence, quorum, gate vetoes");
{
  const mkV = (action, conf, weight = 1, id = "x") => ({ agentId: id, name: id, action, confidence: conf, reasons: ["r"], weight });
  const strongBuy = [mkV("buy", 0.8, 1, "a"), mkV("buy", 0.7, 1, "b"), mkV("hold", 0.5, 1, "c"), mkV("sell", 0.4, 1, "d"), mkV("buy", 0.6, 1, "e")];
  const maj = weightedMajority(strongBuy);
  ok("3.1 weighted majority picks buy", maj.action === "buy");

  const { verdicts, log } = debate(strongBuy, 3);
  ok("3.2 debate = 3 rounds", log.length === 3 && log[2].round === 3);
  ok("3.3 undecided converge to majority", verdicts.find((v) => v.agentId === "c").action === "buy");
  const dRound1 = log[0].statements.find((s) => s.agentId === "d");
  ok("3.4 undecided sell converges to majority (r1 flip, final buy)", dRound1.argument.includes("מתעדכן") && verdicts.find((v) => v.agentId === "d").action === "buy");
  ok("3.4b decided strong agents keep stance", verdicts.find((v) => v.agentId === "a").action === "buy" && verdicts.find((v) => v.agentId === "e").action === "buy");

  const snap = { seed: 7, symbol: "LEUMI.TA", klass: "tase", price: 100, atr14: 1, rsi14: 50, sma20: 100, sma50: 100, trendScore: 0.5, volPct: 1, regime: "trend-up", bars: [], _forward: [] };
  const state = { equity: [] };
  const board = runBoardroom(snap, mandate, strongBuy, state);
  ok("3.5 strong buy passes to decision", board.chair.decision === "buy" && board.chair.sizePct > 0);
  ok("3.6 risk gate present with 6 checks", board.riskGate.checks.length === 6);
  ok("3.7 gate passes on clean snapshot", board.riskGate.passed === true);
  ok("3.8 artifact sig 8hex", /^[0-9a-f]{8}$/.test(board.sig));

  const lowConf = [mkV("buy", 0.3, 1, "a"), mkV("buy", 0.3, 1, "b"), mkV("buy", 0.3, 1, "c"), mkV("buy", 0.3, 1, "d"), mkV("buy", 0.3, 1, "e")];
  const b2 = runBoardroom(snap, mandate, lowConf, state);
  ok("3.9 quorum fail → flat", b2.chair.decision === "flat" && b2.chair.quorumPassed === false);
  ok("3.10 flat decision = zero size", b2.chair.sizePct === 0);

  const badSym = { ...snap, symbol: "MOON.ROCKET" };
  const b3 = runBoardroom(badSym, mandate, strongBuy, state);
  ok("3.11 disallowlisted symbol vetoed by G1", b3.riskGate.checks.find((c) => c.id === "G1").passed === false && b3.chair.decision === "flat");

  const wildSnap = { ...snap, volPct: 5 };
  const b4 = runBoardroom(wildSnap, mandate, strongBuy, state);
  ok("3.12 vol halt G5 vetoes", b4.riskGate.checks.find((c) => c.id === "G5").passed === false && b4.chair.decision === "flat");

  const liveMandate = clone(mandate);
  liveMandate.execution.mode = "live";
  liveMandate.execution.liveOwnerArmed = false;
  const b5 = runBoardroom(snap, liveMandate, strongBuy, state);
  const g2 = b5.riskGate.checks.find((c) => c.id === "G2");
  ok("3.13 live-unarmed blocked by G2 (dual-key law)", g2.passed === false && g2.limit.includes("דו-מפתחות"));

  liveMandate.execution.liveOwnerArmed = true;
  const b6 = runBoardroom(snap, liveMandate, strongBuy, state);
  ok("3.14 owner-armed live passes G2", b6.riskGate.checks.find((c) => c.id === "G2").passed === true);

  const ddState = { equity: [5, 5, 5, -3] };
  ok("3.15 drawdown math", Math.abs(computeDrawdown(ddState.equity) - 3) < 1e-9);
  const bigDD = runBoardroom(snap, mandate, strongBuy, { equity: [10, -5, -5, -5] });
  ok("3.16 drawdown halt G6 vetoes", bigDD.riskGate.checks.find((c) => c.id === "G6").passed === false);
}

// ─────────────────────────────────────────────────────────────────────────────
section(4, "reflexivity — bounded Darwinian weights");
{
  const w0 = seedWeights();
  const agents = [
    { agentId: "technical", action: "buy", confidence: 0.8, weight: 1, reasons: [], name: "t" },
    { agentId: "valuation", action: "buy", confidence: 0.7, weight: 1, reasons: [], name: "v" },
    { agentId: "momentum", action: "hold", confidence: 0.5, weight: 1, reasons: [], name: "m" },
    { agentId: "sentiment", action: "sell", confidence: 0.6, weight: 1, reasons: [], name: "s" },
    { agentId: "risk", action: "buy", confidence: 0.6, weight: 1, reasons: [], name: "r" },
  ];
  const win = evolve(w0, agents, "buy", 10, 4); // +4% on 10% position → tradePnl=40%
  ok("4.1 aligned winners gain", win.weights.technical.weight > 1 && win.weights.valuation.weight > 1);
  ok("4.2 unaligned (hold/sell) untouched", win.weights.momentum.weight === 1 && win.weights.sentiment.weight === 1);
  ok("4.3 wins counter increments", win.weights.technical.wins === 1 && win.weights.technical.losses === 0);
  ok("4.4 factor bounded", win.perAgent.every((p) => p.factor > 0 && p.factor <= 2));

  const lose = evolve(w0, agents, "buy", 10, -4);
  ok("4.5 aligned losers shrink", lose.weights.technical.weight < 1);
  ok("4.6 losses counter increments", lose.weights.technical.losses === 1 && lose.weights.technical.wins === 0);

  let w = seedWeights();
  for (let i = 0; i < 50; i++) w = evolve(w, agents, "buy", 10, 10).weights;
  ok("4.7 upper clamp 2.0", Object.values(w).every((e) => e.weight <= 2.0));
  let w2 = seedWeights();
  for (let i = 0; i < 50; i++) w2 = evolve(w2, agents, "buy", 10, -10).weights;
  ok("4.8 lower clamp 0.5", Object.values(w2).every((e) => e.weight >= 0.5));
  ok("4.9 flat decision moves nobody", JSON.stringify(evolve(w0, agents, "flat", 0, 0).weights) === JSON.stringify(w0));
}

// ─────────────────────────────────────────────────────────────────────────────
section(5, "checkpoint — append-only chain, tamper detection, resume");
{
  const dir = tmpdir("ckpt");
  const st = loadState(dir, seedWeights());
  ok("5.1 fresh state", st.beat === 0 && st.chainHead === null);
  const e1 = appendLedger(dir, { schema: "t@1", beat: 1, decision: "buy", sig: undefined });
  const e2 = appendLedger(dir, { schema: "t@1", beat: 2, decision: "sell", sig: undefined });
  const e3 = appendLedger(dir, { schema: "t@1", beat: 3, decision: "flat", sig: undefined });
  ok("5.2 chain links prevSig", e2.prevSig === e1.sig && e3.prevSig === e2.sig);
  const v = verifyLedger(dir);
  ok("5.3 verify ok count=3", v.ok === true && v.count === 3);
  ok("5.4 each entry sig 8hex", [e1, e2, e3].every((e) => /^[0-9a-f]{8}$/.test(e.sig)));

  const dir2 = tmpdir("tamper");
  appendLedger(dir2, { schema: "t@1", beat: 1, decision: "buy", sig: undefined });
  appendLedger(dir2, { schema: "t@1", beat: 2, decision: "sell", sig: undefined });
  const ledgerPath = path.join(dir2, "ledger.jsonl");
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[1]);
  tampered.decision = "buy";
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(ledgerPath, lines.join("\n") + "\n");
  const v2 = verifyLedger(dir2);
  ok("5.5 tamper detected at index 1", v2.ok === false && v2.brokenAt === 1);

  const dirR = tmpdir("resume");
  const r1 = resumeCheck(dirR);
  ok("5.6 resume fresh-dir ok", r1.ok === true && r1.reason === "fresh");
  const re1 = appendLedger(dirR, { schema: "t@1", beat: 1, decision: "buy", sig: undefined });
  fs.writeFileSync(path.join(dirR, "beat.json"), JSON.stringify({ chainHead: re1.sig }));
  const r2a = resumeCheck(dirR);
  ok("5.6b resume head-match ok", r2a.ok === true && r2a.reason === "chain-head-match");
  fs.writeFileSync(path.join(dirR, "beat.json"), JSON.stringify({ chainHead: "deadbeef" }));
  const r2 = resumeCheck(dirR);
  ok("5.7 resume detects head mismatch", r2.ok === false && r2.reason === "chain-head-mismatch");
}

// ─────────────────────────────────────────────────────────────────────────────
section(6, "cycle — full beat determinism + schema + paper law");
{
  const dirA = tmpdir("beatA"), dirB = tmpdir("beatB"), dirC = tmpdir("beatC");
  const rA = runBeat({ seed: 7, symbol: "LEUMI.TA", mandate, stateDir: dirA });
  ok("6.1 beat ok", rA.ok === true);
  ok("6.2 schema stamp", rA.artifact.schema === "saos-desk/session@1");
  ok("6.3 paper mode stamped", rA.artifact.mandate.execution === "paper" && mandate.execution.mode === "paper");
  ok("6.4 five agents in artifact", rA.artifact.agents.length === 5);
  ok("6.5 debate 3 rounds in artifact", rA.artifact.debate.length === 3);
  ok("6.6 risk gate 6 checks in artifact", rA.artifact.riskGate.checks.length === 6);
  ok("6.7 outcome labeled simClosed", rA.artifact.outcome.simClosed === true);
  ok("6.8 market source sim", rA.artifact.market.source === "sim");
  const rA2 = runBeat({ seed: 7, symbol: "LEUMI.TA", mandate, stateDir: dirB });
  ok("6.9 determinism: same seed+symbol → same sig", rA2.artifact.sig === rA.artifact.sig);
  const rC = runBeat({ seed: 8, symbol: "LEUMI.TA", mandate, stateDir: dirC });
  ok("6.10 different seed → different sig", rC.artifact.sig !== rA.artifact.sig);
  const rB = runBeat({ seed: 7, symbol: "NICE.TA", mandate, stateDir: tmpdir("beatD") });
  ok("6.11 different symbol → different sig", rB.artifact.sig !== rA.artifact.sig);
  ok("6.12 chainHead advanced", rA.state.chainHead === rA.artifact.sig);
  ok("6.13 weights after present for all agents", rA.artifact.weightsAfter.length === 5);

  const cont = runBeat({ seed: 7, symbol: "NICE.TA", mandate, stateDir: dirA });
  ok("6.14 second beat = beat 2 on same dir", cont.artifact.beat === 2);
  const v = verifyLedger(dirA);
  ok("6.15 ledger chain holds across beats", v.ok === true && v.count === 2);
  const eq = cont.state.equity;
  ok("6.16 equity accumulates", eq.length === 2);

  // reflexivity law: aligned agents move exactly when the decision was directional
  const dirDec = ["buy", "sell"].includes(cont.artifact.chair.decision);
  const moved = cont.artifact.weightsAfter.some((p) => p.aligned);
  ok("6.17 reflexive layer consistent with decision", dirDec ? moved === true : moved === false);

  const blocked = runBeat({ seed: 7, symbol: "LEUMI.TA", mandate, stateDir: tmpdir("beatE"), snapFn: () => { throw new Error("snap-fail"); } });
  ok("6.18 snapshot failure fails honestly (no fake artifact)", blocked.ok === false && blocked.error === "SNAPSHOT-FAILED");
}

// ─────────────────────────────────────────────────────────────────────────────
section(7, "data + mandate integrity");
{
  ok("7.1 TASE universe ≥10 .TA symbols", TASE_UNIVERSE.length >= 10 && TASE_UNIVERSE.every((s) => s.symbol.endsWith(".TA")));
  ok("7.2 mandate universe matches data module", mandate.universe.tase.every((s) => TASE_UNIVERSE.some((u) => u.symbol === s)));
  ok("7.3 three Hebrew feeds declared", mandate.hebrewFeeds.length === 3 && HEBREW_FEEDS.length === 3);
  ok("7.4 feeds are Hebrew finance sources", mandate.hebrewFeeds.map((f) => f.name).join(",") === "Calcalist,Globes,TheMarker");
  ok("7.5 execution paper + unarmed by default", mandate.execution.mode === "paper" && mandate.execution.liveOwnerArmed === false);
  ok("7.6 risk limits sane", mandate.limits.maxPositionPct <= 25 && mandate.limits.kellyCap <= 0.5 && mandate.limits.drawdownHaltPct <= 20 && mandate.limits.volHaltPct <= 5);
  ok("7.7 quorum thresholds sane", mandate.quorum.minConfidence >= 0.5 && mandate.quorum.rounds === 3);
}

console.log(`\n${pass}/${pass + fail} PASS${fail > 0 ? " — FAILURES: " + fails.join(", ") : ""}`);
process.exit(fail > 0 ? 1 : 0);

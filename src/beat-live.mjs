// saos-desk beat-live — ONE desk beat on REAL bars (R353, law #14).
// The ONLY network touch stays src/fetch-live.mjs (law #11). No keys, public GET only.
// Dead/insufficient bars = NO-REAL-BARS, honest exit 2 — never a fabricated decision.
// Usage: bun src/beat-live.mjs <symbol> [stateDir]
import fs from "node:fs";
import { hash32 } from "./kernel.mjs";
import { runBeat, seedWeights } from "./cycle.mjs";
import { fetchChart, loadFeedState } from "./fetch-live.mjs";
import { loadState } from "./checkpoint.mjs";

const mandate = JSON.parse(fs.readFileSync(new URL("../mandate.json", import.meta.url), "utf8"));
const symbol = process.argv[2] ?? "TEVA.TA";
const stateDir = process.argv[3] ?? new URL("../state", import.meta.url).pathname;

const md = mandate.marketData ?? { decisionBars: 120, forwardMax: 5, minBars: 121, barRange: "6mo" };

// fetch REAL daily bars — fail-closed on anything short of the decision window + 1 forward bar
const chart = await fetchChart(symbol, {
  hosts: mandate.ingest?.quoteHosts,
  timeoutMs: mandate.ingest?.timeoutMs,
  maxBytes: mandate.ingest?.maxBytes,
  range: md.barRange ?? "6mo",
});
if (!chart.ok || !Array.isArray(chart.bars) || chart.bars.length < (md.minBars ?? 121)) {
  console.log(JSON.stringify({
    ok: false,
    error: "NO-REAL-BARS",
    symbol,
    reason: chart.ok ? `bars:${chart.bars?.length ?? 0}-below-min:${md.minBars}` : (chart.reason ?? "fetch-failed"),
  }, null, 2));
  process.exit(2);
}

// the beat consults the sealed feed state — same REFRAIN law as cycle.mjs (R345)
const feed = loadFeedState(stateDir, Date.now(), { maxAgeMin: mandate.ingest?.freshnessMaxMin ?? 90 });
const feedAssessment = feed.ok ? feed.assessment : { verdict: "REFRAIN", reasons: [feed.reason ?? "feed-state-unavailable"] };

// deterministic seed contract, same as the console: (1000003*beat + hash32(symbol)) % 2147483647
const state = loadState(stateDir, seedWeights());
const seed = (1000003 * (state.beat + 1) + hash32(symbol)) % 2147483647;

const r = await runBeat({
  seed, symbol,
  klass: mandate.universe.tase.includes(symbol) ? "tase" : (mandate.universe.global.includes(symbol) ? "global" : "tase"),
  mandate, stateDir,
  wallClock: new Date().toISOString(),
  feedAssessment,
  realBars: chart.bars,
});

if (!r.ok) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  sig: r.artifact.sig,
  beat: r.artifact.beat,
  symbol: r.artifact.symbol,
  dataMode: r.artifact.dataMode,
  price: r.artifact.market.price,
  decision: r.artifact.chair.decision,
  sizePct: r.artifact.chair.sizePct,
  outcome: r.artifact.outcome,
  feed: r.artifact.feed,
}, null, 2));

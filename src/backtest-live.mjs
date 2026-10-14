// saos-desk backtest-live — run the pure backtest engine on REAL artery bars (R346)
// Orchestration module (network via fetchText, fs for sealing) — the engine itself stays pure.
// Fail-closed: symbols whose bars fail validation are recorded honestly, never fabricated.
import fs from "node:fs";
import { fetchText } from "./fetch-live.mjs";
import { parseChart } from "./ingest.mjs";
import { runBacktest } from "./backtest.mjs";
import { sig8 } from "./kernel.mjs";

export async function runLiveBacktest(mandate, { range = "6mo" } = {}) {
  const ing = mandate.ingest ?? {};
  const results = [];
  for (const symbol of [...(mandate.universe?.tase ?? []), ...(mandate.universe?.global ?? [])]) {
    const url = `${(ing.quoteHosts?.[0] ?? "https://query1.finance.yahoo.com")}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const r = await fetchText(url, { timeoutMs: ing.timeoutMs ?? 8000, maxBytes: ing.maxBytes ?? 262144 });
    if (!r.ok) {
      results.push({ symbol, ok: false, reason: r.reason });
      continue;
    }
    const parsed = parseChart(r.body);
    if (!parsed.ok) {
      results.push({ symbol, ok: false, reason: parsed.reason });
      continue;
    }
    const bt = runBacktest(parsed.bars, mandate.positions ?? {});
    if (!bt.ok) {
      results.push({ symbol, ok: false, reason: bt.reason });
      continue;
    }
    results.push({
      symbol,
      ok: true,
      bars: bt.bars,
      firstBar: parsed.bars[0]?.t ?? null,
      lastBar: parsed.bars[parsed.bars.length - 1]?.t ?? null,
      stats: bt.stats,
      equity: bt.equity,
    });
  }
  const entry = {
    schema: "saos-desk/backtest@1",
    range,
    ranAt: new Date().toISOString(),
    results,
  };
  entry.sig = sig8({ ...entry, sig: undefined });
  return entry;
}

export function sealBacktest(stateDir, entry) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(`${stateDir}/backtest-latest.json`, JSON.stringify(entry, null, 2) + "\n");
  return entry;
}

// CLI: bun src/backtest-live.mjs [range]
const isMain = process.argv[1] && process.argv[1].endsWith("backtest-live.mjs");
if (isMain) {
  const mandate = JSON.parse(fs.readFileSync(new URL("../mandate.json", import.meta.url), "utf8"));
  const range = process.argv[2] ?? "6mo";
  console.log(`מפעל-הבקטסט על נתונים חיים (R346) — range=${range}, אפס מפתחות…`);
  const entry = await runLiveBacktest(mandate, { range });
  sealBacktest(new URL("../state", import.meta.url).pathname, entry);
  for (const r of entry.results) {
    if (!r.ok) {
      console.log(`  ${r.symbol.padEnd(10)} FAIL ${r.reason}`);
      continue;
    }
    const s = r.stats;
    console.log(`  ${r.symbol.padEnd(10)} trades=${String(s.tradeCount).padEnd(3)} hit=${s.hitRate === null ? "—" : `${Math.round(s.hitRate * 100)}%`} sharpe=${s.sharpe ?? "—"} maxDD=${s.maxDrawdownPct}% ret=${s.totalReturnPct}%`);
  }
  console.log(`sig: ${entry.sig} → state/backtest-latest.json`);
}

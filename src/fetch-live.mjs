// saos-desk fetch-live — the ONLY module allowed to touch the network (R345)
// exec33 doctrine #1: no live credentials — public GET endpoints only, zero keys.
// Fail-closed: every failure is recorded honestly; nothing is ever synthesized.
// This is the network/clock side of the artery; src/ingest.mjs stays pure.
import fs from "node:fs";
import path from "node:path";
import { assessFeeds, parseChart, parseRss, feedSig } from "./ingest.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 saos-desk/1 (sovereign; keyless)";

export async function fetchText(url, { timeoutMs = 8000, maxBytes = 262144 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "*/*" },
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) return { ok: false, reason: `content-length-${len}-exceeds-cap-${maxBytes}` };
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "no-body" };
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } return { ok: false, reason: `stream-exceeds-cap-${maxBytes}` }; }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { ok: true, bytes: total, body };
  } catch (e) {
    const msg = String(e?.message ?? e);
    return { ok: false, reason: msg === "timeout" ? "timeout" : `network:${msg.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchChart(symbol, { hosts, timeoutMs, maxBytes, range = "1mo" } = {}) {
  const hs = hosts ?? ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  let lastErr = { ok: false, reason: "no-hosts" };
  for (const host of hs) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
    const r = await fetchText(url, { timeoutMs, maxBytes });
    if (!r.ok) { lastErr = { symbol, ok: false, reason: r.reason }; continue; }
    const parsed = parseChart(r.body);
    if (!parsed.ok) { lastErr = { symbol, ok: false, reason: parsed.reason }; continue; }
    return { symbol, ok: true, ...parsed };
  }
  return lastErr;
}

export async function fetchRss(name, url, opts = {}) {
  const r = await fetchText(url, opts);
  if (!r.ok) return { feed: name, ok: false, reason: r.reason };
  const parsed = parseRss(r.body, opts);
  if (!parsed.ok) return { feed: name, ok: false, reason: parsed.reason, stats: parsed.stats };
  return { feed: name, ok: true, items: parsed.items, stats: parsed.stats };
}

// probe everything the mandate declares — never throws, failures are data
export async function probeAll(mandate, { timeoutMs, maxBytes } = {}) {
  const ing = mandate.ingest ?? {};
  const tMs = timeoutMs ?? ing.timeoutMs ?? 8000;
  const mB = maxBytes ?? ing.maxBytes ?? 262144;
  const opts = { timeoutMs: tMs, maxBytes: mB };
  const quotes = [];
  for (const s of [...(mandate.universe?.tase ?? []), ...(mandate.universe?.global ?? [])]) {
    quotes.push(await fetchChart(s, { hosts: ing.quoteHosts, ...opts }));
  }
  const news = [];
  for (const f of [...(mandate.ingest?.hebrewNews ?? []), ...(mandate.hebrewFeeds ?? [])]) {
    news.push(await fetchRss(f.name, f.url, { ...opts, maxItems: ing.maxRssItems ?? 12 }));
  }
  return { quotes, news, probedAt: new Date().toISOString(), opts: { timeoutMs: tMs, maxBytes: mB } };
}

// seal the probe as a signed snapshot (payload-without-sig law) — wall clock lives here
export function sealFeedState(stateDir, probed, mandate, nowMs = Date.now()) {
  const ageMin = Math.round((nowMs - Date.parse(probed.probedAt)) / 60000);
  const assessment = assessFeeds(probed, {
    minAliveRatio: mandate.ingest?.minAliveRatio ?? 0.7,
    anomalyMovePct: mandate.ingest?.anomalyMovePct ?? 12,
    maxAgeMin: mandate.ingest?.freshnessMaxMin ?? 90,
    freshnessMin: ageMin,
  });
  const entry = {
    schema: "saos-desk/feed-state@1",
    probedAt: probed.probedAt,
    ageMin,
    opts: probed.opts,
    quotes: probed.quotes.map((q) => ({
      symbol: q.symbol, ok: q.ok, last: q.last ?? null, prevClose: q.prevClose ?? null,
      changePct: q.changePct ?? null, currency: q.currency ?? null, exchange: q.exchange ?? null,
      bars: q.ok ? q.bars : undefined,
      reason: q.ok ? undefined : q.reason,
    })),
    news: probed.news.map((n) => ({ feed: n.feed, ok: n.ok, items: n.ok ? n.items : undefined, stats: n.stats, reason: n.ok ? undefined : n.reason })),
    assessment,
  };
  entry.sig = feedSig({ ...entry, sig: undefined });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "feed-latest.json"), JSON.stringify(entry, null, 2) + "\n");
  return entry;
}

export function loadFeedState(stateDir, nowMs = Date.now(), { maxAgeMin = 90 } = {}) {
  const p = path.join(stateDir, "feed-latest.json");
  if (!fs.existsSync(p)) return { ok: false, reason: "no-feed-state" };
  let entry;
  try { entry = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { ok: false, reason: "feed-state-unparseable" }; }
  const expect = feedSig({ ...entry, sig: undefined });
  if (entry.sig !== expect) return { ok: false, reason: "FEED-STATE-TAMPERED", sig: entry.sig ?? null, expect };
  const ageMin = Math.round((nowMs - Date.parse(entry.probedAt)) / 60000);
  if (!Number.isFinite(ageMin)) return { ok: false, reason: "probedAt-unparseable" };
  const stale = ageMin > maxAgeMin;
  const assessment = entry.assessment ?? null;
  // staleness upgrades ALIVE -> REFRAIN (an old artery is a dead artery); tamper/dead state is already fail-closed above
  if (assessment && !stale) return { ok: true, fresh: true, ageMin, entry, assessment };
  return {
    ok: true, fresh: false, ageMin, entry,
    assessment: assessment
      ? { ...assessment, verdict: "REFRAIN", reasons: [...(assessment.reasons ?? []), `נתונים מזדקנים (${ageMin}דק > ${maxAgeMin}דק) — REFRAIN`], ratio: assessment.ratio ?? 0 }
      : { verdict: "REFRAIN", reasons: ["feed-state-טעון-חידוש — אין הערכה חתומה"], ratio: 0 },
  };
}

// CLI: bun src/fetch-live.mjs [--state DIR]
const isMain = process.argv[1] && process.argv[1].endsWith("fetch-live.mjs");
if (isMain) {
  const mandate = JSON.parse(fs.readFileSync(new URL("../mandate.json", import.meta.url), "utf8"));
  const stateDir = new URL("../state", import.meta.url).pathname;
  console.log("מדדים חיים — עורק-הנתונים (R345), אפס מפתחות, fail-closed…");
  const probed = await probeAll(mandate);
  const entry = sealFeedState(stateDir, probed, mandate);
  const a = entry.assessment;
  console.log(`פסיקת-עורק: ${a.verdict} (חיים ${a.alive}/${a.alive + a.dead + a.anomalies}, יחס ${(a.ratio * 100).toFixed(1)}%)`);
  for (const r of a.reasons) console.log(`  · ${r}`);
  for (const s of a.symbols) console.log(`  ${s.symbol.padEnd(10)} ${s.verdict.padEnd(7)} ${s.last != null ? `last=${s.last} Δ=${s.changePct}%` : (s.reason ?? "")}`);
  for (const n of a.news) console.log(`  ${n.feed.padEnd(18)} ${n.verdict.padEnd(7)} items=${n.items}${n.reason ? " " + n.reason : ""}`);
  console.log(`sig: ${entry.sig} → state/feed-latest.json`);
}

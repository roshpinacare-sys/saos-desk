// saos-desk data adapters — TASE universe, Hebrew feeds, live-data probe (R338)
// The pure core never imports this module. Everything here fails CLOSED and honest.
import { genSeries } from "./kernel.mjs";

export const TASE_UNIVERSE = [
  { symbol: "LEUMI.TA", name: "בנק לאומי" },
  { symbol: "FIBI.TA", name: "הפועלים" },
  { symbol: "POLI.TA", name: "בנק דיסקונט" },
  { symbol: "NICE.TA", name: "נייס" },
  { symbol: "TEVA.TA", name: "טבע" },
  { symbol: "ICL.TA", name: "ICL" },
  { symbol: "ESLT.TA", name: "אלקטרוניקס" },
  { symbol: "BEZQ.TA", name: "בזק" },
  { symbol: "MZTF.TA", name: "מזטף" },
  { symbol: "DSEA.TA", name: "דירה להשקיעות" },
];

export const GLOBAL_UNIVERSE = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "נאסדק 100" },
  { symbol: "BTC-USD", name: "ביטקוין" },
];

export const HEBREW_FEEDS = [
  { name: "Calcalist", url: "https://www.calcalist.co.il/AllNews.xml" },
  { name: "Globes", url: "https://www.globes.co.il/webservice/rss/rss_feeds_rss20.xml?fid=1042" },
  { name: "TheMarker", url: "https://www.themarker.com/cserver/rss/allnews" },
];

// live probe: fail-closed honest. The sandbox is usually offline for finance —
// the cycle records {ok:false, reason} instead of inventing numbers.
export async function tryFetchYahooDaily(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (!r?.timestamp || !q?.close) return { ok: false, reason: "shape" };
    const bars = r.timestamp.map((t, i) => ({
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0,
    })).filter((b) => b.c != null);
    return { ok: true, bars, source: "yahoo" };
  } catch (e) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : "offline" };
  }
}

// Hebrew RSS probe: same honesty. Headlines only; the sentiment agent in the pure
// core stays deterministic — a live headlines stamp rides on the artifact.
export async function tryFetchFeed(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
      .map((m) => m[1].trim())
      .filter((t) => t.length > 0 && !/^(rss|feed)/i.test(t))
      .slice(0, 10);
    return { ok: true, headlines: titles };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

export function simBars(seed, symbol) {
  return { ok: true, bars: genSeries(seed, symbol, 140), source: "sim" };
}

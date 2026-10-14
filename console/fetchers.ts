// saos-desk fetchers — the console's ONLY network touchpoint (R345/R346)
// Mirrors repos/saos-desk/src/fetch-live.mjs: public GET endpoints, zero keys,
// timeout + byte-cap, fail-closed, drops counted. Server-only (node runtime).
import { MANDATE } from "@/lib/desk/mandate";
import { parseChart, type ChartParsed } from "@/lib/desk/ingest";

export const FETCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 saos-desk-console/1 (sovereign; keyless)";

export async function fetchText(url: string): Promise<{ ok: boolean; body?: string; reason?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), MANDATE.ingest.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": FETCH_UA, Accept: "*/*" },
      redirect: "follow",
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MANDATE.ingest.maxBytes) return { ok: false, reason: `content-length-${len}-exceeds-cap` };
    const body = await res.text();
    if (body.length > MANDATE.ingest.maxBytes) return { ok: false, reason: `body-${body.length}-exceeds-cap` };
    return { ok: true, body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg === "timeout" ? "timeout" : `network:${msg.slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
  }
}

// quote probe with host fallback (fail-closed, honest reasons)
export async function probeQuote(symbol: string): Promise<{ symbol: string; ok: boolean; reason?: string } & Partial<ChartParsed>> {
  let last: { ok: boolean; reason?: string } = { ok: false, reason: "no-hosts" };
  for (const host of MANDATE.ingest.quoteHosts) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
    const r = await fetchText(url);
    if (!r.ok) {
      last = { ok: false, reason: r.reason };
      continue;
    }
    const parsed = parseChart(r.body ?? "");
    if (!parsed.ok) {
      last = { ok: false, reason: parsed.reason };
      continue;
    }
    return { symbol, ok: true, ...parsed };
  }
  return { symbol, ok: false, reason: last.reason };
}

// ---- bars cache (per symbol+range, TTL) — the engine room needs daily depth ----
interface BarsCacheEntry {
  at: number;
  chart: { symbol: string; ok: boolean; reason?: string } & Partial<ChartParsed>;
}
const barsCache = new Map<string, BarsCacheEntry>();
const BARS_TTL_MS = 60_000;

export async function fetchBars(symbol: string, range = "6mo"): Promise<{ symbol: string; ok: boolean; reason?: string } & Partial<ChartParsed>> {
  const key = `${symbol}|${range}`;
  const hit = barsCache.get(key);
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.chart;
  let lastErr: { ok: boolean; reason?: string } = { ok: false, reason: "no-hosts" };
  for (const host of MANDATE.ingest.quoteHosts) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const r = await fetchText(url);
    if (!r.ok) {
      lastErr = { ok: false, reason: r.reason };
      continue;
    }
    const parsed = parseChart(r.body ?? "");
    if (!parsed.ok) {
      lastErr = { ok: false, reason: parsed.reason };
      continue;
    }
    const chart = { symbol, ok: true as const, ...parsed };
    barsCache.set(key, { at: Date.now(), chart });
    return chart;
  }
  return { symbol, ok: false, reason: lastErr.reason };
}

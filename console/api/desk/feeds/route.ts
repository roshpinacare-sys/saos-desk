import { NextResponse } from "next/server";
import { MANDATE } from "@/lib/desk/mandate";
import { assessFeeds, parseChart, parseRss, screenText } from "@/lib/desk/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// saos-desk live artery — GET /api/desk/feeds (R345)
// The ONLY network touchpoint of the console, mirroring repos/saos-desk/src/fetch-live.mjs:
// public GET endpoints, zero keys, timeout + byte-cap, fail-closed, drops counted.
// 60s in-memory cache so the page polls honestly without hammering the feeds.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 saos-desk-console/1 (sovereign; keyless)";
const CACHE_MS = 60_000;

interface Cached {
  at: number;
  payload: unknown;
}
let cache: Cached | null = null;

async function fetchText(url: string): Promise<{ ok: boolean; body?: string; reason?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), MANDATE.ingest.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "*/*" },
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

async function probeQuote(symbol: string) {
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
  return { symbol, ok: false as const, reason: last.reason };
}

async function probeNews(name: string, url: string) {
  const r = await fetchText(url);
  if (!r.ok) return { feed: name, ok: false as const, reason: r.reason };
  const parsed = parseRss(r.body ?? "", { maxItems: MANDATE.ingest.maxRssItems });
  if (!parsed.ok) return { feed: name, ok: false as const, reason: parsed.reason, stats: parsed.stats };
  return { feed: name, ok: true as const, items: parsed.items, stats: parsed.stats };
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ ...(cache.payload as object), cached: true });
  }
  try {
    const probedAt = new Date().toISOString();
    const quotes = await Promise.all(
      [...MANDATE.universe.tase, ...MANDATE.universe.global].map((s) => probeQuote(s))
    );
    const news = await Promise.all([
      ...MANDATE.ingest.hebrewNews.map((f) => probeNews(f.name, f.url)),
      ...MANDATE.hebrewFeeds.map((f) => probeNews(f.name, f.url)),
    ]);

    const assessment = assessFeeds(
      { quotes, news, probedAtMin: 0 },
      {
        minAliveRatio: MANDATE.ingest.minAliveRatio,
        anomalyMovePct: MANDATE.ingest.anomalyMovePct,
        maxAgeMin: MANDATE.ingest.freshnessMaxMin,
        freshnessMin: 0,
      }
    );

    // screening evidence (honest counts) + the live headlines that survived
    const screened = news.map((n) => ({
      feed: n.feed,
      ok: n.ok,
      reason: n.ok ? undefined : n.reason,
      stats: n.stats,
      items: n.ok
        ? (n.items ?? []).slice(0, 6).map((it: { title: string; link: string | null; date: string | null }) => ({
            title: screenText(it.title, 300).clean,
            link: it.link,
            date: it.date,
          }))
        : [],
    }));

    const payload = {
      ok: true as const,
      probedAt,
      verdict: assessment.verdict,
      ratio: assessment.ratio,
      alive: assessment.alive,
      dead: assessment.dead,
      anomalies: assessment.anomalies,
      reasons: assessment.reasons,
      symbols: assessment.symbols,
      screening: {
        quotesProbed: quotes.length,
        newsFeedsProbed: news.length,
        injectionDrops: screened.reduce((a, s) => a + (s.stats?.droppedInjection ?? 0), 0),
        malformedDrops: screened.reduce((a, s) => a + (s.stats?.droppedMalformed ?? 0), 0),
      },
      headlines: screened,
      keyless: true,
      doctrine: "exec33 — אפס מפתחות, סינון אפס-אמון, fail-closed, כלום לא מומצא",
    };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false as const,
        error: "artery-unavailable",
        message: `עורק-הנתונים אינו זמין כרגע: ${String(e instanceof Error ? e.message : e)} — fail-closed, שום נתון לא מומצא.`,
      },
      { status: 502 }
    );
  }
}

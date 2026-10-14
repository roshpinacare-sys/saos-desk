import { NextResponse } from "next/server";
import { MANDATE } from "@/lib/desk/mandate";
import { sig8 } from "@/lib/desk/engine";
import { runBacktest } from "@/lib/desk/backtest";
import { fetchBars } from "@/lib/desk/fetchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// saos-desk backtest — GET /api/desk/backtest?symbol=X&range=6mo (R346)
// Real daily bars from the artery → the pure lookahead-free engine → real metrics.
// 5-minute per-(symbol,range) cache. Fail-closed on dead symbols.

const RANGES = new Set(["3mo", "6mo", "1y"]);
const CACHE_TTL_MS = 300_000;
const cache = new Map<string, { at: number; payload: unknown }>();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const range = url.searchParams.get("range") ?? "6mo";
  if (!symbol) {
    return NextResponse.json({ ok: false as const, message: "חסר פרמטר symbol." }, { status: 400 });
  }
  if (!MANDATE.universe.tase.includes(symbol) && !MANDATE.universe.global.includes(symbol)) {
    return NextResponse.json({ ok: false as const, message: `הסמל ${symbol} אינו באוניברס-המנדט.` }, { status: 400 });
  }
  if (!RANGES.has(range)) {
    return NextResponse.json({ ok: false as const, message: `טווח לא נתמך (${range}) — 3mo/6mo/1y בלבד.` }, { status: 400 });
  }
  const key = `${symbol}|${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...(hit.payload as object), cached: true });
  }
  try {
    const chart = await fetchBars(symbol, range);
    if (!chart.ok) {
      return NextResponse.json(
        { ok: false as const, message: `אין נתונים חיים ל${symbol} (${chart.reason}) — fail-closed.` },
        { status: 409 }
      );
    }
    const bt = runBacktest(chart.bars ?? [], MANDATE.positions);
    if (!bt.ok) {
      return NextResponse.json({ ok: false as const, message: `המנוע סירב: ${bt.reason}` }, { status: 409 });
    }
    const payload = {
      ok: true as const,
      symbol,
      range,
      bars: bt.bars,
      stats: bt.stats,
      equity: bt.equity,
      trades: bt.trades?.slice(-30).reverse(),
      firstBar: chart.bars?.[0]?.t ?? null,
      lastBar: chart.bars?.[(chart.bars?.length ?? 1) - 1]?.t ?? null,
      sig: sig8({ symbol, range, stats: bt.stats, trades: bt.trades?.length ?? 0 }),
      note: "בקטסט על נרות אמיתיים — מדידה, לא הבטחת-תשואה",
    };
    cache.set(key, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      { ok: false as const, message: `מפעל-הבקטסט נכשל: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

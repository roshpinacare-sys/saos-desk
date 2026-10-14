import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MANDATE } from "@/lib/desk/mandate";
import { sig8 } from "@/lib/desk/engine";
import {
  openGate,
  openPosition,
  markPosition,
  portfolioState,
  historicalVaR,
  type PaperPosition,
  type MarkBar,
} from "@/lib/desk/positions";
import { fetchBars } from "@/lib/desk/fetchers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// saos-desk positions — the paper book (R346)
// The LAW is repos/saos-desk/src/positions.mjs (ported 1:1 to src/lib/desk/positions.ts).
// GET    → mark open positions on fresh DAILY bars (at most once per trading day),
//          auto-fire hard stops, return the book + portfolio state + historical VaR.
// POST   → { action: "open", symbol, side, sizePct? } opens at the LIVE price (fail-closed),
//          or { action: "close", id } closes manually at the live mark.
// Paper-only by mandate; REFRAIN/anomaly/dead symbol = no new positions.

function rowToPosition(row: {
  id: string; symbol: string; side: string; sizePct: number; status: string;
  entryPrice: number; stopPrice: number; targetPrice: number; riskPerUnit: number;
  atrAtEntry: number; barsHeld: number; lastMarkT: number; lastMark: number;
  unrealizedPct: number; openedAt: Date; events: string;
  exitPrice: number | null; realizedPct: number | null; closedAt: Date | null; closeReason: string | null;
}): PaperPosition & { lastMarkT: number } {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side as "buy" | "sell",
    sizePct: row.sizePct,
    status: row.status,
    entryPrice: row.entryPrice,
    stopPrice: row.stopPrice,
    targetPrice: row.targetPrice,
    riskPerUnit: row.riskPerUnit,
    atrAtEntry: row.atrAtEntry,
    openedAt: row.openedAt.toISOString(),
    lastMark: row.lastMark,
    lastMarkT: row.lastMarkT,
    unrealizedPct: row.unrealizedPct,
    barsHeld: row.barsHeld,
    events: JSON.parse(row.events) as PaperPosition["events"],
    exitPrice: row.exitPrice,
    realizedPct: row.realizedPct,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closeReason: row.closeReason,
  };
}

export async function GET() {
  try {
    const rows = await db.deskPosition.findMany({ orderBy: { openedAt: "desc" }, take: 100 });
    const book = rows.map(rowToPosition);
    const openRows = book.filter((p) => p.status === "OPEN");

    // mark each open position on its symbol's latest DAILY bar — only fresh timestamps advance the clock
    const marksBySymbol = new Map<string, { last: number | null; bar: MarkBar | null; ok: boolean; reason?: string }>();
    const uniqSymbols = [...new Set(openRows.map((p) => p.symbol))];
    const nowIso = new Date().toISOString();
    for (const symbol of uniqSymbols) {
      const chart = await fetchBars(symbol, "1mo");
      const bars = chart.ok ? (chart.bars ?? []) : [];
      const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
      marksBySymbol.set(symbol, {
        ok: chart.ok,
        reason: chart.ok ? undefined : chart.reason,
        last: chart.ok ? (chart.last ?? null) : null,
        bar: lastBar ? { t: lastBar.t, o: lastBar.o, h: lastBar.h, l: lastBar.l, c: lastBar.c } : null,
      });
    }
    const marked: Record<string, PaperPosition & { lastMarkT: number }> = {};
    for (const p of openRows) {
      const m = marksBySymbol.get(p.symbol);
      const freshBar = m?.bar && m.bar.t > p.lastMarkT ? m.bar : null;
      const { position, closed } = markPosition(p, freshBar, MANDATE.positions, { nowIso });
      marked[p.id] = { ...(closed ?? position), lastMarkT: freshBar?.t ?? p.lastMarkT };
    }

    // persist marks + stop-fires (the book is real state)
    for (const [id, p] of Object.entries(marked)) {
      await db.deskPosition.update({
        where: { id },
        data: {
          status: p.status,
          lastMark: p.lastMark,
          lastMarkT: p.lastMarkT,
          unrealizedPct: p.unrealizedPct,
          barsHeld: p.barsHeld,
          exitPrice: p.exitPrice ?? null,
          realizedPct: p.realizedPct ?? null,
          closedAt: p.closedAt ? new Date(p.closedAt) : null,
          closeReason: p.closeReason ?? null,
          events: JSON.stringify(p.events),
        },
      });
    }

    // historical VaR from real daily returns of the OPEN symbols (3mo depth, mandate-gated)
    const weights: Record<string, number> = {};
    const returnsBySymbol: Record<string, number[]> = {};
    for (const p of openRows) {
      weights[p.symbol] = (weights[p.symbol] ?? 0) + p.sizePct / 100;
    }
    for (const symbol of Object.keys(weights)) {
      const chart = await fetchBars(symbol, "3mo");
      const bars = chart.ok ? (chart.bars ?? []) : [];
      const rets: number[] = [];
      for (let i = 1; i < bars.length; i++) rets.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
      returnsBySymbol[symbol] = rets;
    }
    const varRes = historicalVaR(weights, returnsBySymbol, { confidence: MANDATE.positions.varConfidence });

    const finalBook = [
      ...book.filter((p) => p.status !== "OPEN"),
      ...Object.values(marked),
    ].sort((a, b) => (a.status === b.status ? 0 : a.status === "OPEN" ? -1 : 1));
    const portfolio = portfolioState(finalBook, []);
    return NextResponse.json({
      ok: true as const,
      positions: finalBook,
      portfolio,
      var: varRes,
      marks: [...marksBySymbol.entries()].map(([symbol, m]) => ({ symbol, ok: m.ok, last: m.last, reason: m.reason ?? null })),
      mandate: MANDATE.positions,
      paperOnly: true,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false as const, error: "positions-unavailable", message: `ספר-העמדות אינו זמין: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: { action?: string; symbol?: string; side?: string; sizePct?: number; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false as const, message: "גוף-הבקשה אינו JSON תקין." }, { status: 400 });
  }

  try {
    if (body.action === "close") {
      if (!body.id) return NextResponse.json({ ok: false as const, message: "חסר מזהה-עמדה לסגירה." }, { status: 400 });
      const row = await db.deskPosition.findUnique({ where: { id: body.id } });
      if (!row) return NextResponse.json({ ok: false as const, message: "עמדה לא נמצאה." }, { status: 404 });
      if (row.status !== "OPEN") return NextResponse.json({ ok: false as const, message: "העמדה כבר סגורה." }, { status: 409 });
      const chart = await fetchBars(row.symbol, "1mo");
      if (!chart.ok) {
        return NextResponse.json(
          { ok: false as const, message: `אין מחיר-חי לסגירה (${chart.reason}) — fail-closed, העמדה לא נסגרה במחיר-מומצא.` },
          { status: 409 }
        );
      }
      const exitPrice = chart.last ?? row.lastMark;
      const exitPct =
        row.side === "buy"
          ? ((exitPrice - row.entryPrice) / row.entryPrice) * 100
          : ((row.entryPrice - exitPrice) / row.entryPrice) * 100;
      const nowIso = new Date().toISOString();
      const events = JSON.parse(row.events) as { type: string; at: string | null; price: number }[];
      events.push({ type: "MANUAL-CLOSE", at: nowIso, price: exitPrice });
      const updated = await db.deskPosition.update({
        where: { id: row.id },
        data: {
          status: "CLOSED",
          exitPrice,
          realizedPct: Math.round(exitPct * 10000) / 10000,
          closedAt: new Date(),
          closeReason: "MANUAL-CLOSE",
          lastMark: exitPrice,
          events: JSON.stringify(events),
        },
      });
      return NextResponse.json({ ok: true as const, position: updated });
    }

    if (body.action === "open") {
      const symbol = body.symbol;
      const side = body.side;
      if (!symbol || (side !== "buy" && side !== "sell")) {
        return NextResponse.json({ ok: false as const, message: "חסר סמל או צד חוקי (buy/sell)." }, { status: 400 });
      }
      if (!MANDATE.universe.tase.includes(symbol) && !MANDATE.universe.global.includes(symbol)) {
        return NextResponse.json({ ok: false as const, message: `הסמל ${symbol} אינו באוניברס-המנדט.` }, { status: 400 });
      }
      if (MANDATE.execution.mode !== "paper" || !MANDATE.positions.paperOnly) {
        return NextResponse.json({ ok: false as const, message: "המנדט אינו נייר — פתיחת-עמדות חסומה." }, { status: 403 });
      }
      const chart = await fetchBars(symbol, "1mo");
      if (!chart.ok) {
        return NextResponse.json(
          { ok: false as const, message: `הסמל ${symbol} מת בעורק (${chart.reason}) — אין פתיחה במחיר-מומצא.` },
          { status: 409 }
        );
      }
      const bars = chart.bars ?? [];
      const lastBar = bars[bars.length - 1];
      const entry = chart.last ?? lastBar.c;
      const changePct = chart.changePct ?? 0;
      if (Math.abs(changePct) > MANDATE.ingest.anomalyMovePct) {
        return NextResponse.json(
          { ok: false as const, message: `חריגה-מבנית ב-${symbol} (תנועה ${changePct}%) — חשד-זיוף, אין פתיחה עד אישור-בעלים.` },
          { status: 409 }
        );
      }
      // ATR from real bars (14) — the stops law
      let trSum = 0;
      const atrN = Math.min(14, bars.length - 1);
      for (let i = bars.length - atrN; i < bars.length; i++) {
        const prevC = bars[i - 1].c;
        trSum += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevC), Math.abs(bars[i].l - prevC));
      }
      const atrValue = atrN > 0 ? trSum / atrN : 0;
      const openRows = await db.deskPosition.findMany({ where: { status: "OPEN" } });
      const openPositions = openRows.map(rowToPosition);
      const sizePct =
        typeof body.sizePct === "number" && body.sizePct > 0
          ? body.sizePct
          : Math.min(10, MANDATE.limits.maxPositionPct);
      const gate = openGate({
        openPositions,
        side,
        sizePct,
        symbol,
        maxPositionPct: MANDATE.limits.maxPositionPct,
        positionsCfg: MANDATE.positions,
      });
      if (!gate.allowed) {
        return NextResponse.json(
          { ok: false as const, message: `שער-הפתיחה מטיל וטו: ${gate.reasons.join(" · ")}` },
          { status: 409 }
        );
      }
      const nowIso = new Date().toISOString();
      const openSig = sig8({ symbol, side, entry, at: nowIso, kind: "desk-position-open" });
      const opened = openPosition({
        id: openSig,
        symbol,
        side,
        sizePct,
        entryPrice: entry,
        atrValue,
        at: nowIso,
        cfg: MANDATE.positions,
        prevSig: null,
      });
      if (!opened.ok || !opened.position) {
        return NextResponse.json({ ok: false as const, message: opened.reason ?? "פתיחה נכשלה." }, { status: 409 });
      }
      const created = await db.deskPosition.create({
        data: {
          id: openSig,
          symbol,
          side,
          sizePct,
          status: "OPEN",
          entryPrice: opened.position.entryPrice,
          stopPrice: opened.position.stopPrice,
          targetPrice: opened.position.targetPrice,
          riskPerUnit: opened.position.riskPerUnit,
          atrAtEntry: opened.position.atrAtEntry,
          lastMarkT: lastBar.t,
          lastMark: opened.position.lastMark,
          events: JSON.stringify(opened.position.events),
          sig: openSig,
        },
      });
      return NextResponse.json({ ok: true as const, position: created });
    }

    return NextResponse.json({ ok: false as const, message: "פעולה לא מוכרת (open/close בלבד)." }, { status: 400 });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes("Unique constraint")) {
      return NextResponse.json({ ok: false as const, message: "עמדה זהה נפתחה זה-עתה (sig-כפול) — 409 כנה." }, { status: 409 });
    }
    return NextResponse.json({ ok: false as const, message: `פעולת-עמדה נכשלה: ${msg}` }, { status: 500 });
  }
}

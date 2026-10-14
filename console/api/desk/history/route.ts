import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { DeskArtifact } from "@/lib/desk/types";

export const dynamic = "force-dynamic";

// GET /api/desk/history?limit=10 — the last N beats, parsed from the stored artifact.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rawLimit = parseInt(url.searchParams.get("limit") ?? "10", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 10;

    const rows = await db.deskBeat.findMany({ orderBy: { beat: "desc" }, take: limit });

    const items = rows.map((row) => {
      let art: DeskArtifact | null = null;
      try {
        art = JSON.parse(row.artifact) as DeskArtifact;
      } catch {
        art = null;
      }
      return {
        id: row.id,
        beat: row.beat,
        seed: row.seed,
        symbol: row.symbol,
        regime: row.regime,
        decision: row.decision,
        sizePct: row.sizePct,
        confidence: row.confidence,
        quorumPassed: row.quorumPassed,
        riskPassed: row.riskPassed,
        realizedPct: row.realizedPct,
        sig: row.sig,
        createdAt: row.createdAt,
        // parsed from the artifact (honest nulls when the stored JSON is unreadable)
        agents: art?.agents ?? null,
        debate: art?.debate ?? null,
        chair: art?.chair ?? null,
        riskGate: art?.riskGate ?? null,
        outcome: art?.outcome ?? null,
        weightsAfter: art?.weightsAfter ?? null,
        marketBasic: art
          ? {
              price: art.market.price,
              atr14: art.market.atr14,
              rsi14: art.market.rsi14,
              sma20: art.market.sma20,
              sma50: art.market.sma50,
              trendScore: art.market.trendScore,
              volPct: art.market.volPct,
              source: art.market.source,
            }
          : null,
        // closes for the sparkline (bars are [o, h, l, c] — c at index 3)
        closes: art ? art.market.bars.map((b) => b[3]) : null,
        artifactError: art ? null : "artifact-unreadable",
      };
    });

    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "history-unavailable", message: `טעינת הפנקס נכשלה: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

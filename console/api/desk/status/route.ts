import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { MANDATE } from "@/lib/desk/mandate";
import { AGENT_IDS, seedWeights } from "@/lib/desk/engine";

export const dynamic = "force-dynamic";

// GET /api/desk/status — the desk state: mandate rails, weights, beat count, chain head, equity
export async function GET() {
  try {
    const beats = await db.deskBeat.findMany({
      orderBy: { beat: "asc" },
      select: { realizedPct: true, sig: true },
    });

    const weightRows = await db.deskWeight.findMany();
    const weights: Record<string, { weight: number; wins: number; losses: number }> = {};
    for (const id of AGENT_IDS) {
      const row = weightRows.find((r) => r.agentId === id);
      weights[id] = row
        ? { weight: row.weight, wins: row.wins, losses: row.losses }
        : { weight: 1, wins: 0, losses: 0 };
    }

    const chainHead = beats.length > 0 ? beats[beats.length - 1].sig : null;

    return NextResponse.json({
      execution: MANDATE.execution.mode,
      liveOwnerArmed: MANDATE.execution.liveOwnerArmed,
      universe: MANDATE.universe,
      feeds: MANDATE.hebrewFeeds.map((f) => f.name),
      limits: MANDATE.limits,
      weights,
      beatCount: beats.length,
      chainHead,
      equity: beats.map((b) => b.realizedPct),
      seedWeights: seedWeights(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "status-unavailable", message: `טעינת מצב-השולחן נכשלה: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

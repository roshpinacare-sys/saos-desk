import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { MANDATE, symbolClass } from "@/lib/desk/mandate";
import { AGENT_IDS, deriveSeed, runBeatPure, seedWeights } from "@/lib/desk/engine";
import type { Weights } from "@/lib/desk/types";

export const dynamic = "force-dynamic";

// In-process mutex: one beat at a time, so beat numbers and the sig chain stay honest.
let beatQueue: Promise<unknown> = Promise.resolve();

// POST /api/desk/session — run ONE full desk beat: snapshot -> cabinet -> boardroom
// -> sim outcome -> reflexivity -> persist DeskBeat + evolve DeskWeight.
export async function POST(req: Request) {
  let body: { symbol?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad-json", message: "גוף-הבקשה אינו JSON תקין." },
      { status: 400 }
    );
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
  if (!symbol) {
    return NextResponse.json(
      { ok: false, error: "symbol-required", message: "לא נבחר סימל — בחר סימל מהאוניברס ונסה שוב." },
      { status: 400 }
    );
  }

  const klass = symbolClass(symbol);
  if (klass === null) {
    return NextResponse.json(
      { ok: false, error: "symbol-not-in-universe", message: `הסימל ${symbol} אינו באוניברס המנדט — הרכב-האוניברס: 10 סימלי ת\"א + SPY/QQQ/BTC-USD.` },
      { status: 400 }
    );
  }

  const run = beatQueue.then(() => runOneBeat(symbol, klass));
  // keep the queue alive even if this beat fails
  beatQueue = run.catch(() => undefined);
  return run;
}

async function runOneBeat(symbol: string, klass: "tase" | "global") {
  try {
    const beatCount = await db.deskBeat.count();
    const beat = beatCount + 1;
    const seed = deriveSeed(beat, symbol);

    // weights: loaded from the DeskWeight table, seeded 1.0/0/0 per agent if empty
    const weightRows = await db.deskWeight.findMany();
    const weights: Weights = seedWeights();
    for (const id of AGENT_IDS) {
      const row = weightRows.find((r) => r.agentId === id);
      if (row) weights[id] = { weight: row.weight, wins: row.wins, losses: row.losses };
    }

    // equity (ordered by beat asc) feeds the drawdown check G6
    const priorBeats = await db.deskBeat.findMany({ orderBy: { beat: "asc" }, select: { realizedPct: true, sig: true } });
    const equity = priorBeats.map((b) => b.realizedPct);
    const prevSig = priorBeats.length > 0 ? priorBeats[priorBeats.length - 1].sig : "GENESIS";

    const { entry, evolvedWeights } = runBeatPure({
      seed,
      symbol,
      klass,
      mandate: MANDATE,
      beat,
      weights,
      equity,
      prevSig,
      wallClock: new Date().toISOString(),
    });

    await db.deskBeat.create({
      data: {
        seed,
        beat,
        symbol,
        regime: entry.regime,
        decision: entry.chair.decision,
        sizePct: entry.chair.sizePct,
        confidence: entry.chair.confidence,
        quorumPassed: entry.chair.quorumPassed,
        riskPassed: entry.riskGate.passed,
        realizedPct: entry.outcome.realizedPct,
        sig: entry.sig ?? "",
        artifact: JSON.stringify(entry),
      },
    });

    // reflexivity: upsert evolved weights per agent
    for (const id of AGENT_IDS) {
      const w = evolvedWeights[id] ?? { weight: 1, wins: 0, losses: 0 };
      await db.deskWeight.upsert({
        where: { agentId: id },
        create: { agentId: id, weight: w.weight, wins: w.wins, losses: w.losses },
        update: { weight: w.weight, wins: w.wins, losses: w.losses },
      });
    }

    return NextResponse.json({ ok: true, artifact: entry });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { ok: false, error: "duplicate-sig", message: "התנגשות חתימה-ייחודית (sig כבר קיים בפנקס) — המושב לא נרשם. נסה שוב." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "beat-failed", message: `הרצת המושב נכשלה: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

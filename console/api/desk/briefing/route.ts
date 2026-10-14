import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { symbolName } from "@/lib/desk/mandate";
import type { DeskArtifact } from "@/lib/desk/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REGIME_HE: Record<string, string> = {
  "trend-up": "מגמה עולה",
  "trend-down": "מגמה יורדת",
  "choppy-highvol": "תנודתי גבוה",
  "choppy-lowvol": "תנודתי נמוך",
};

const DECISION_HE: Record<string, string> = {
  buy: "קנייה",
  sell: "מכירה",
  flat: "שטוח",
};

function fmt(x: number | undefined | null): string {
  return typeof x === "number" && Number.isFinite(x) ? String(x) : "—";
}

// POST /api/desk/briefing { beatId? } — a Hebrew chair briefing built ONLY from
// the artifact numbers of one stored beat. On any failure: honest unavailability,
// never invented text.
export async function POST(req: Request) {
  try {
    let body: { beatId?: number } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    let row = null;
    if (typeof body.beatId === "number" && Number.isFinite(body.beatId)) {
      row = await db.deskBeat.findUnique({ where: { id: body.beatId } });
      if (!row) {
        return NextResponse.json(
          { ok: false, reason: "briefing-unavailable", message: `מושב #${body.beatId} לא נמצא בפנקס.` },
          { status: 404 }
        );
      }
    } else {
      row = await db.deskBeat.findFirst({ orderBy: { beat: "desc" } });
      if (!row) {
        return NextResponse.json(
          { ok: false, reason: "briefing-unavailable", message: "עדיין לא התקיים מושב — הרץ כנס מושב ואז בקש תדריך." },
          { status: 404 }
        );
      }
    }

    let art: DeskArtifact | null = null;
    try {
      art = JSON.parse(row.artifact) as DeskArtifact;
    } catch {
      art = null;
    }
    if (!art) {
      return NextResponse.json(
        { ok: false, reason: "briefing-unavailable", message: "הארטיפקט של המושב אינו קריא — התדריך אינו זמין כרגע." },
        { status: 500 }
      );
    }

    // compact Hebrew summary — the artifact numbers ONLY
    const passed = art.riskGate.checks.filter((c) => c.passed).length;
    const summaryText = [
      `מושב #${art.beat} · סימל ${art.symbol} (${symbolName(art.symbol)}) · משטר: ${REGIME_HE[art.regime] ?? art.regime}`,
      `החלטת היו"ר: ${DECISION_HE[art.chair.decision] ?? art.chair.decision} · גודל עמדה: ${fmt(art.chair.sizePct)}% · ביטחון: ${fmt(art.chair.confidence)}`,
      `קוורום: ${art.chair.quorumPassed ? "עובר" : "נכשל"} · שער-הסיכון: ${passed}/${art.riskGate.checks.length} בדיקות עברו (${art.riskGate.passed ? "המשך" : "וטו"})`,
      `תוצאה מדודה בסימולציה: ${fmt(art.outcome?.realizedPct)}%`,
    ].join("\n");

    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: 'אתה יו"ר חדר-הישיבות הריבוני למסחר. תדריך בעברית, 2-4 משפטים, על בסיס המספרים שניתנו בלבד. אסור להמציא מספרים. סיים במשפט משמעת-סיכון.' },
        { role: "user", content: summaryText },
      ],
      thinking: { type: "disabled" },
    });

    const briefing: string | undefined = completion?.choices?.[0]?.message?.content;
    if (typeof briefing !== "string" || briefing.trim().length === 0) {
      return NextResponse.json(
        { ok: false, reason: "briefing-unavailable", message: "התדריך אינו זמין כרגע — המודל לא החזיר טקסט." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, briefing: briefing.trim(), beatId: row.id, beat: row.beat });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: "briefing-unavailable", message: `התדריך אינו זמין כרגע: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

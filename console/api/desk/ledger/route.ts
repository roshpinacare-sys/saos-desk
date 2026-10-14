import { NextResponse } from "next/server";
import { ensureGenesisLedger, readLedgerChain } from "@/lib/desk/ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// saos-desk ledger — GET /api/desk/ledger (R347)
// הספר-הריבוני: רשומות-DeFi לפסיקות-השולחן. כל קריאה מאמתת את השרשרת כולה
// (schema + kind + seq מונוטוני + prevSig + sig8) — אפס אמון, פגיעה = דיווח מדויק.

export async function GET() {
  try {
    await ensureGenesisLedger();
    const { entries, chain } = await readLedgerChain();
    return NextResponse.json({
      ok: true as const,
      schema: "saos-dex/desk-entry@1",
      chain,
      entries,
      paperOnly: true,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false as const, error: "ledger-unavailable", message: `הספר-הריבוני אינו זמין: ${String(e instanceof Error ? e.message : e)}` },
      { status: 500 }
    );
  }
}

// saos-desk ledger — הספר-הריבוני: רשומות-DeFi לפסיקות-השולחן (R350)
// ============================================================================
// המקור: מפת-הדרך של הבעלים — "הרחבת-סכימת saos-dex לרשומות-DeFi" + דוקטרינת
// exec34 (רישום #31): ההון מיוצר דרך ה-ledger שלנו (saos-dex), לא דרך ברוקר.
// הגשר החוקי: כל פסיקת-עמדה של השולחן הופכת לרשומת-DeFi בצורת פרימיטיבים מוכרים.
//
// מיפוי-הפרימיטיבים (כנה — נייר-בלבד, LAWS #13):
//   deposit      — הפקדת-בסיס בפתיחת-הספר (מדד-הון = 10000bps, לא מומצא מספר-מוחלט)
//   escrow_lock  — פתיחת-עמדה (המרת-מזומן→חשיפה; ערבות-נעולה בגודל-המדוד)
//   settle       — סגירת-עמדה (מימוש מדוד: realizedBps + טעם-הסגירה)
//   withdraw     — נתמך-בסכימה, לעולם לא נרשם אוטומטית (אין משיכות בחוק-הנייר)
//
// חוקי-יחידות (מורשת saos-dex — שלמים-בלבד חוצים את החתימה):
//   bps = round(pct × 100)      — אחוזים כנקודות-בסיס שלמות
//   mu  = round(price × 10000)  — מחירים בנקודה-קבועה 4-ספרות (µ-מקביל)
//
// חוק-האפס (R330): אין שעון, אין רנדום, אין רשת, אין fs. כל רשומה ניתנת לשחזור
// מ-(position, seq, prevSig). שדות-זמן מגיעים מהבארים/העמדה בלבד; חסר = null.
// חוק-השרשרת: seq מונוטוני, prevSig מקשר, sig8 על canonical-ללא-החתימה.
// Fail-closed: עמדה פגומה = סירוב-מנומק, אפס רשומות. אין ניחוש, אין המצאה.

import { round4, canonical, sig8 } from "./kernel.mjs";

export const LEDGER_SCHEMA = "saos-dex/desk-entry@1";
export const LEDGER_KINDS = ["deposit", "escrow_lock", "settle", "withdraw"];

const MU = 10000; // נקודה-קבועה 4-ספרות למחירים
const BPS = 100; // אחוזים → נקודות-בסיס

// ---- יחידות: המרות שלמות עם סירוב-כנה ---------------------------------------
function toMu(price) {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * MU);
}

function toBps(pct) {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return Math.round(pct * BPS);
}

// ---- חתימה: canonical-ללא-sig → sig8 -----------------------------------------
function sealRecord(record) {
  const { sig, ...rest } = record;
  return { ...record, sig: sig8(rest) };
}

// ---- בנאי-רשומות (כל בנאי fail-closed) ---------------------------------------
function buildRecord({ kind, seq, prevSig, body }) {
  if (!LEDGER_KINDS.includes(kind)) return { ok: false, reason: `KIND-REFUSED:${kind}` };
  if (!Number.isInteger(seq) || seq < 0) return { ok: false, reason: "SEQ-REFUSED" };
  if (prevSig !== null && (typeof prevSig !== "string" || prevSig.length !== 8)) return { ok: false, reason: "PREVSIG-REFUSED" };
  const record = {
    schema: LEDGER_SCHEMA,
    seq,
    kind,
    prevSig,
    ...body,
  };
  return { ok: true, record: sealRecord(record) };
}

/** deposit — הפקדת-בסיס: מדד-ההון מתחיל ב-100% (10000bps) — לא מספר-מוחלט מומצא. */
export function genesisDeposit({ seq, prevSig = null, note = "בסיס-הספר: מדד-הון 100%" }) {
  return buildRecord({
    kind: "deposit",
    seq,
    prevSig,
    body: { equityBps: 100 * BPS, note: typeof note === "string" ? note : null },
  });
}

/** escrow_lock — פתיחת-עמדה: החשיפה ננעלת בגודל-המדוד עם העוצרים הקשיחים. */
export function positionToLock(position, seq, prevSig = null) {
  if (!position || typeof position !== "object") return { ok: false, reason: "POSITION-REFUSED" };
  if (position.status !== "OPEN") return { ok: false, reason: "NOT-OPEN" };
  if (position.side !== "buy" && position.side !== "sell") return { ok: false, reason: "SIDE-REFUSED" };
  const sizeBps = toBps(position.sizePct);
  const entryMu = toMu(position.entryPrice);
  const stopMu = toMu(position.stopPrice);
  const targetMu = toMu(position.targetPrice);
  const atrMu = toMu(position.atrAtEntry);
  if (sizeBps === null || sizeBps <= 0) return { ok: false, reason: "SIZE-REFUSED" };
  if (entryMu === null || stopMu === null || targetMu === null || atrMu === null) return { ok: false, reason: "PRICE-REFUSED" };
  return buildRecord({
    kind: "escrow_lock",
    seq,
    prevSig,
    body: {
      positionId: typeof position.id === "string" ? position.id : null,
      symbol: typeof position.symbol === "string" ? position.symbol : null,
      side: position.side,
      sizeBps,
      entryMu,
      stopMu,
      targetMu,
      atrMu,
      at: typeof position.openedAt === "string" ? position.openedAt : null,
    },
  });
}

/** settle — סגירת-עמדה: המימוש המדוד (רווח/הפסד כנה, כולל הפסדים) נרשם לנצח. */
export function positionToSettle(position, seq, prevSig = null) {
  if (!position || typeof position !== "object") return { ok: false, reason: "POSITION-REFUSED" };
  if (position.status !== "CLOSED") return { ok: false, reason: "NOT-CLOSED" };
  const sizeBps = toBps(position.sizePct);
  const entryMu = toMu(position.entryPrice);
  const exitMu = toMu(position.exitPrice);
  const realizedBps = toBps(position.realizedPct);
  if (sizeBps === null || sizeBps <= 0) return { ok: false, reason: "SIZE-REFUSED" };
  if (entryMu === null || exitMu === null) return { ok: false, reason: "PRICE-REFUSED" };
  if (realizedBps === null) return { ok: false, reason: "REALIZED-REFUSED" };
  if (typeof position.closeReason !== "string" || position.closeReason.length === 0) return { ok: false, reason: "REASON-REFUSED" };
  if (!Number.isInteger(position.barsHeld) || position.barsHeld < 0) return { ok: false, reason: "BARS-REFUSED" };
  return buildRecord({
    kind: "settle",
    seq,
    prevSig,
    body: {
      positionId: typeof position.id === "string" ? position.id : null,
      symbol: typeof position.symbol === "string" ? position.symbol : null,
      side: position.side,
      sizeBps,
      entryMu,
      exitMu,
      realizedBps,
      closeReason: position.closeReason,
      barsHeld: position.barsHeld,
      at: typeof position.closedAt === "string" ? position.closedAt : null,
    },
  });
}

// ---- אימות-שרשרת: sig + prevSig + seq + סוגים --------------------------------
/** verifyLedgerChain(records) → {ok, count, brokenAt, reasons} — אפס אמון בקריאה. */
export function verifyLedgerChain(records) {
  if (!Array.isArray(records)) return { ok: false, count: 0, brokenAt: null, reasons: ["NOT-ARRAY"] };
  const reasons = [];
  let prevSig = null;
  let prevSeq = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const at = `#${i}`;
    if (!r || typeof r !== "object") { reasons.push(`${at}:RECORD-REFUSED`); continue; }
    if (r.schema !== LEDGER_SCHEMA) reasons.push(`${at}:SCHEMA`);
    if (!LEDGER_KINDS.includes(r.kind)) reasons.push(`${at}:KIND`);
    if (!Number.isInteger(r.seq) || r.seq !== prevSeq + 1) reasons.push(`${at}:SEQ`);
    if ((r.prevSig ?? null) !== prevSig) reasons.push(`${at}:PREVSIG`);
    const { sig, ...rest } = r;
    if (sig !== sig8(rest)) reasons.push(`${at}:SIG`);
    if (reasons.length === 0) {
      prevSig = r.sig;
      prevSeq = r.seq;
    } else {
      return { ok: false, count: records.length, brokenAt: i, reasons };
    }
  }
  return { ok: reasons.length === 0, count: records.length, brokenAt: null, reasons };
}

/** הפקת-רשומות מאירוע-עמדה: פתיחה → escrow_lock, סגירה → settle. fail-closed. */
export function eventToLedgerRecords(position, { seq, prevSig = null } = {}) {
  if (!position || typeof position !== "object") return { ok: false, reason: "POSITION-REFUSED", records: [] };
  if (position.status === "OPEN") {
    const r = positionToLock(position, seq, prevSig);
    return r.ok ? { ok: true, records: [r.record] } : { ok: false, reason: r.reason, records: [] };
  }
  if (position.status === "CLOSED") {
    const r = positionToSettle(position, seq, prevSig);
    return r.ok ? { ok: true, records: [r.record] } : { ok: false, reason: r.reason, records: [] };
  }
  return { ok: false, reason: "STATUS-REFUSED", records: [] };
}

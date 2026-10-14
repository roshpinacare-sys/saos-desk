// saos-desk ledger — הספר-הריבוני: פורט 1:1 של repos/saos-desk/src/ledger.mjs (R347)
// Server-only (sig8/canonical come from engine.ts which uses node:crypto).
// Units law: integers only cross the signature (bps = pct×100, mu = price×10000).
// No clock: time fields come from the position/bar only; missing = null.
// The DB row is the book; the payload is the signed record itself (the evidence).

import { db } from "@/lib/db";
import { canonical, sig8 } from "./engine";
import type { PaperPosition } from "./positions";

export const LEDGER_SCHEMA = "saos-dex/desk-entry@1" as const;
export const LEDGER_KINDS = ["deposit", "escrow_lock", "settle", "withdraw"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerRecord {
  schema: typeof LEDGER_SCHEMA;
  seq: number;
  kind: LedgerKind;
  prevSig: string | null;
  sig: string;
  // deposit
  equityBps?: number;
  note?: string | null;
  // escrow_lock / settle
  positionId?: string | null;
  symbol?: string | null;
  side?: "buy" | "sell";
  sizeBps?: number;
  entryMu?: number;
  stopMu?: number;
  targetMu?: number;
  atrMu?: number;
  exitMu?: number;
  realizedBps?: number;
  closeReason?: string;
  barsHeld?: number;
  at?: string | null;
}

export interface LedgerBuildResult {
  ok: boolean;
  reason?: string;
  record?: LedgerRecord;
  records?: LedgerRecord[];
}

const MU = 10000;
const BPS = 100;

function toMu(price: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * MU);
}

function toBps(pct: unknown): number | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return Math.round(pct * BPS);
}

function sealRecord(record: Omit<LedgerRecord, "sig">): LedgerRecord {
  return { ...record, sig: sig8(record) };
}

function buildRecord(kind: LedgerKind, seq: number, prevSig: string | null, body: Record<string, unknown>): LedgerBuildResult {
  if (!Number.isInteger(seq) || seq < 0) return { ok: false, reason: "SEQ-REFUSED" };
  if (prevSig !== null && (typeof prevSig !== "string" || prevSig.length !== 8)) return { ok: false, reason: "PREVSIG-REFUSED" };
  return { ok: true, record: sealRecord({ schema: LEDGER_SCHEMA, seq, kind, prevSig, ...body } as Omit<LedgerRecord, "sig">) };
}

export function genesisDeposit(seq: number, prevSig: string | null = null, note: string | null = "בסיס-הספר: מדד-הון 100%"): LedgerBuildResult {
  return buildRecord("deposit", seq, prevSig, { equityBps: 100 * BPS, note });
}

export function positionToLock(position: PaperPosition, seq: number, prevSig: string | null = null): LedgerBuildResult {
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
  return buildRecord("escrow_lock", seq, prevSig, {
    positionId: typeof position.id === "string" ? position.id : null,
    symbol: typeof position.symbol === "string" ? position.symbol : null,
    side: position.side,
    sizeBps,
    entryMu,
    stopMu,
    targetMu,
    atrMu,
    at: typeof position.openedAt === "string" ? position.openedAt : null,
  });
}

export function positionToSettle(position: PaperPosition, seq: number, prevSig: string | null = null): LedgerBuildResult {
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
  return buildRecord("settle", seq, prevSig, {
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
  });
}

export function eventToLedgerRecords(position: PaperPosition, seq: number, prevSig: string | null = null): LedgerBuildResult {
  if (!position || typeof position !== "object") return { ok: false, reason: "POSITION-REFUSED", records: [] };
  if (position.status === "OPEN") {
    const r = positionToLock(position, seq, prevSig);
    return r.ok ? { ok: true, records: [r.record!] } : { ok: false, reason: r.reason, records: [] };
  }
  if (position.status === "CLOSED") {
    const r = positionToSettle(position, seq, prevSig);
    return r.ok ? { ok: true, records: [r.record!] } : { ok: false, reason: r.reason, records: [] };
  }
  return { ok: false, reason: "STATUS-REFUSED", records: [] };
}

export function verifyLedgerChain(records: LedgerRecord[]): { ok: boolean; count: number; brokenAt: number | null; reasons: string[] } {
  if (!Array.isArray(records)) return { ok: false, count: 0, brokenAt: null, reasons: ["NOT-ARRAY"] };
  const reasons: string[] = [];
  let prevSig: string | null = null;
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

// ---- DB helpers (the book) ----------------------------------------------------
// Mirror law: the sovereign receipt anchor is saos-dex (loopback). Best-effort,
// HONEST: failure never blocks the local record; the mirror column carries the truth.

async function mirrorToDex(record: LedgerRecord): Promise<string> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch("http://127.0.0.1:3010/saos-dex/api/dex/desk-ledger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (res.ok) return "OK";
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    return `REFUSED:${res.status}${j.message ? ":" + String(j.message).slice(0, 80) : ""}`;
  } catch (e) {
    return `UNREACHED:${String(e instanceof Error ? e.message : e).slice(0, 80)}`;
  }
}

async function nextLedgerSeq(): Promise<number> {
  const last = await db.deskLedgerEntry.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, sig: true } });
  return (last?.seq ?? -1) + 1;
}

/** אפנד יחיד: מוודא שרשרת, חותם, כותב, ומנסה מראה-קבלה מהדקס (כנה, לא חוסם). */
export async function appendLedgerRecord(record: LedgerRecord, positionRef?: { positionId?: string | null; symbol?: string | null }) {
  const mirror = await mirrorToDex(record);
  return db.deskLedgerEntry.create({
    data: {
      seq: record.seq,
      kind: record.kind,
      positionId: record.positionId ?? positionRef?.positionId ?? null,
      symbol: record.symbol ?? positionRef?.symbol ?? null,
      payload: canonical(record),
      sig: record.sig,
      prevSig: record.prevSig,
      mirror,
    },
  });
}

/** פתיחת/סגירת-עמדה → רשומה חתומה בספר (escrow_lock / settle). fail-closed: סירוב מוחזר, אפס רשומות. */
export async function appendPositionToLedger(position: PaperPosition) {
  const prev = await db.deskLedgerEntry.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, sig: true } });
  const seq = (prev?.seq ?? -1) + 1;
  const built = eventToLedgerRecords(position, seq, prev?.sig ?? null);
  if (!built.ok || !built.records || built.records.length === 0) {
    return { ok: false as const, reason: built.reason ?? "LEDGER-BUILD-REFUSED" };
  }
  const record = built.records[0];
  try {
    const row = await appendLedgerRecord(record, { positionId: record.positionId, symbol: record.symbol });
    return { ok: true as const, seq: record.seq, kind: record.kind, sig: record.sig, mirror: row.mirror };
  } catch (e) {
    return { ok: false as const, reason: `LEDGER-WRITE-REFUSED:${String(e instanceof Error ? e.message : e).slice(0, 80)}` };
  }
}

/** בסיס-הספר: deposit חד-פעמי (מדד-הון 100%) אם הספר ריק. */
export async function ensureGenesisLedger() {
  const count = await db.deskLedgerEntry.count();
  if (count > 0) return { ok: true as const, created: false };
  const built = genesisDeposit(0, null);
  if (!built.ok || !built.record) return { ok: false as const, reason: built.reason };
  await appendLedgerRecord(built.record);
  return { ok: true as const, created: true };
}

export interface LedgerRowView {
  seq: number;
  kind: string;
  symbol: string | null;
  positionId: string | null;
  at: string | null;
  realizedBps: number | null;
  sizeBps: number | null;
  entryMu: number | null;
  exitMu: number | null;
  closeReason: string | null;
  equityBps: number | null;
  sig: string;
  prevSig: string | null;
  mirror: string | null;
  createdAt: string;
}

/** קריאת-הספר + אימות-אפס-אמון של השרשרת כולה. */
export async function readLedgerChain(take = 200): Promise<{ entries: LedgerRowView[]; chain: { ok: boolean; count: number; brokenAt: number | null; reasons: string[] } }> {
  const rows = await db.deskLedgerEntry.findMany({ orderBy: { seq: "asc" }, take });
  const records: LedgerRecord[] = rows.map((r) => JSON.parse(r.payload) as LedgerRecord);
  const chain = verifyLedgerChain(records);
  const entries: LedgerRowView[] = rows.map((r, i) => {
    const rec = records[i];
    return {
      seq: r.seq,
      kind: r.kind,
      symbol: r.symbol,
      positionId: r.positionId,
      at: rec.at ?? null,
      realizedBps: rec.realizedBps ?? null,
      sizeBps: rec.sizeBps ?? null,
      entryMu: rec.entryMu ?? null,
      exitMu: rec.exitMu ?? null,
      closeReason: rec.closeReason ?? null,
      equityBps: rec.equityBps ?? null,
      sig: r.sig,
      prevSig: r.prevSig,
      mirror: r.mirror,
      createdAt: r.createdAt.toISOString(),
    };
  });
  return { entries, chain };
}

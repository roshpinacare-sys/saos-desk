// saos-desk — dex pre-trade risk cabinet (directive §7C, trace 1a1693b4c50c0941)
// ==============================================================================
// The POLICY half of the desk→dex risk wiring. saos-dex enforces the same
// contract in src/lib/dex/risk.ts (mirrored constants + verdict shape) so the
// gate can be swapped to import this module directly once both PRs merge.
//
// LAWS honored (LAWS.md):
//   · law 2  — pure module: no clock, no unseeded randomness, no network, no fs.
//   · law 3  — the mandate is hard law: every limit here is DERIVED from
//              mandate@4 fields, never hardcoded beside the check.
//   · law 13 — units law: integers-only across the signature (µ / bps); the
//              cabinet refuses any float/NaN/negative that would cross it.
//   · law 5  — receipts are append-only with a sig chain; tamper is measured,
//              never absorbed (verifyCabinetChain).
//
// Verdict shape parity: same {id,label,passed,measured,limit} records as
// boardroom.riskGate (G1..G6) so one audit view reads both cabinets.
// Scope (v1): DEX_TRADE_OPS = order | fill | pool_swap — the immediate
// funds-movers; batch ops recurse per-sub-op at the enforcement point.

import { canonical, sig8 } from "./kernel.mjs";

export const CABINET_SCHEMA = "saos-desk/dex-cabinet@1";

/** The v1 intercepted op set — the immediate funds-movers on saos-dex. */
export const DEX_TRADE_OPS = ["order", "fill", "pool_swap"];

/**
 * Capital-index base in µ. Desk law 13 denominates capital as a 10000bps
 * index (deposit = base), so every limit below is a PERCENTAGE of this base —
 * no absolute invented number, only the mandate's percentages applied.
 */
export const CABINET_BASE_CAPITAL_MU = 10_000_000;

/** Slippage-guard tier: 10% of the per-order notional cap. */
export const SLIPPAGE_GUARD_FRACTION = 0.1;

/**
 * Derives the cabinet limits from a mandate@4 document.
 * Throws on a mandate missing the sourced fields (law 3 — fail closed on a
 * hard-law document that cannot feed the gate).
 *
 * Deliberately IGNORES execution.mode / liveOwnerArmed: the paper law (law 1)
 * governs desk→broker execution, not the sovereign dex gate — flipping the
 * execution fields must not move the cabinet contract (proven by selftest).
 */
export function cabinetLimitsFromMandate(mandate) {
  const L = mandate?.limits;
  const P = mandate?.positions;
  if (!L || typeof L.maxPositionPct !== "number" || !(L.maxPositionPct > 0)) {
    throw new Error("cabinet: mandate.limits.maxPositionPct missing or invalid (law 3 — fail closed)");
  }
  if (!P || typeof P.maxOpenPositions !== "number" || !(P.maxOpenPositions > 0)) {
    throw new Error("cabinet: mandate.positions.maxOpenPositions missing or invalid (law 3 — fail closed)");
  }
  const maxNotionalMu = Math.floor((CABINET_BASE_CAPITAL_MU * L.maxPositionPct) / 100);
  return {
    schema: CABINET_SCHEMA,
    maxNotionalMu,
    maxTradesPerIssuerInFlight: P.maxOpenPositions,
    minOutRequiredAboveMu: Math.floor(maxNotionalMu * SLIPPAGE_GUARD_FRACTION),
    // Signature of ONLY the sourced mandate fields — the dex gate can pin this
    // and prove it enforces the same mandate version.
    mandateSig: sig8({
      maxPositionPct: L.maxPositionPct,
      kellyCap: L.kellyCap ?? null,
      maxOpenPositions: P.maxOpenPositions,
      tieLaw: P.tieLaw ?? null,
    }),
  };
}

/**
 * Notional in µ-quote for a trade op — MIRRORS the dex kernel exactly
 * (saos-dex src/lib/dex/kernel.ts: `notional = floor(price×amountMu/1000)`,
 * price=µ-quote/unit · amount=µ-base). Priced order/fill → the mirror;
 * market fills and swaps (no price) → amount as µ-base. A unit-factor drift
 * between cabinet and kernel would fake the cap — the selftest pins the
 * formula shape on both sides.
 */
function notionalMu(op) {
  const amount = typeof op.amount === "number" ? op.amount : 0;
  const price = typeof op.price === "number" && op.price > 0 ? op.price : 0;
  return price > 0 ? Math.floor((price * amount) / 1000) : amount;
}

/** Trade-shaped fields — an op carrying them is a trade intent, whatever its claimed type. */
const TRADE_SHAPE_FIELDS = ["base", "quote", "side", "pair", "assetIn"];

function isTradeShaped(op) {
  return TRADE_SHAPE_FIELDS.some((f) => op[f] !== undefined);
}

/**
 * The pure pre-trade evaluation. Returns the riskGate verdict shape:
 *   { allowed, verdicts: [{id,label,passed,measured,limit}], fails: [ids] }
 * Non-trade ops pass through untouched (C0) — the kernel and route guards
 * own them; the cabinet owns the funds-movers only.
 */
export function dexPreTradeCabinet(op, limits, ctx = {}) {
  if (!limits || limits.schema !== CABINET_SCHEMA) {
    throw new Error("cabinet: limits must come from cabinetLimitsFromMandate (law 3 — no ad-hoc limits)");
  }
  if (!op || typeof op !== "object") {
    throw new Error("cabinet: op must be an object (fail closed)");
  }

  // Classification: known trade ops AND trade-shaped ops (base/quote/side/pair/
  // assetIn present) are cabinet scope — an unknown type wearing trade fields is
  // an unclassifiable trade intent and FAILS CLOSED (directive §3: unverified
  // state never sails through). Only genuinely non-trade ops (no trade fields)
  // pass through as C0 — the kernel and route guards own them.
  if (!DEX_TRADE_OPS.includes(op.type) && !isTradeShaped(op)) {
    return {
      allowed: true,
      verdicts: [{ id: "C0", label: "מחוץ-לתחום-הקבינט — נבדק בשכבות-אחרות", passed: true, measured: String(op.type ?? "?"), limit: DEX_TRADE_OPS.join("|") }],
      fails: [],
    };
  }

  const verdicts = [];

  // C1 — units law (law 13): every numeric field that crosses the signature
  // must be a non-negative integer; amount must be present and positive. An
  // unknown type in trade shape is denied here (unclassifiable intent).
  const knownType = DEX_TRADE_OPS.includes(op.type);
  const numericFields = ["amount", "price", "minOut", "amountB"];
  const badFields = numericFields.filter((f) => {
    const v = op[f];
    if (v === undefined) return false;
    return typeof v !== "number" || !Number.isInteger(v) || v < 0;
  });
  const amountOk = typeof op.amount === "number" && Number.isInteger(op.amount) && op.amount > 0;
  verdicts.push({
    id: "C1",
    label: "חוק-יחידות: שלמים-בלבד חוצים-את-החתימה (law 13)",
    passed: knownType && badFields.length === 0 && amountOk,
    measured: !knownType ? `unknown-type:${String(op.type)}` : badFields.length > 0 ? badFields.join(",") : String(op.amount ?? "missing"),
    limit: knownType ? "integers-only, amount>0" : DEX_TRADE_OPS.join("|"),
  });

  // C2 — per-order notional cap (mandate.limits.maxPositionPct of the base index).
  const nMu = notionalMu(op);
  verdicts.push({
    id: "C2",
    label: "תקרת-גודל-פקודה ≤ אחוז-המנדט מבסיס-ההון",
    passed: nMu <= limits.maxNotionalMu,
    measured: nMu,
    limit: limits.maxNotionalMu,
  });

  // C3 — per-issuer in-flight velocity (mandate.positions.maxOpenPositions).
  const inFlight = typeof ctx.inFlight === "number" && Number.isInteger(ctx.inFlight) && ctx.inFlight >= 0 ? ctx.inFlight : 0;
  verdicts.push({
    id: "C3",
    label: "תחום-מהירות: פקודות-פתוחות-למנפיק ≤ מרבי-המנדט",
    passed: inFlight < limits.maxTradesPerIssuerInFlight,
    measured: inFlight,
    limit: limits.maxTradesPerIssuerInFlight,
  });

  // C4 — slippage guard (SETTLE-9 defense-in-depth): a pool_swap above the
  // guard tier must carry a protective minOut ≥ 1 (0 counts as absent).
  if (op.type === "pool_swap") {
    const needsGuard = amountOk && op.amount >= limits.minOutRequiredAboveMu;
    const hasGuard = typeof op.minOut === "number" && op.minOut >= 1;
    verdicts.push({
      id: "C4",
      label: "מגן-החלקה: swap מעל-סף חייב minOut (SETTLE-9 בעומק-הגרעין)",
      passed: !needsGuard || hasGuard,
      measured: needsGuard ? (op.minOut ?? "absent") : `below-${limits.minOutRequiredAboveMu}`,
      limit: `minOut≥1 when amount≥${limits.minOutRequiredAboveMu}`,
    });
  }

  const fails = verdicts.filter((v) => !v.passed).map((v) => v.id);
  return { allowed: fails.length === 0, verdicts, fails };
}

/**
 * Appends one hash-linked receipt for a cabinet verdict (law 5 discipline).
 * `prev` = previous receipt or null (genesis). ctx = { seq, at } — the caller
 * owns monotonic seq and time; the module stays clock-free (law 2).
 * opDigest tolerates garbage ops: canonical() stringifies non-finite numbers
 * deterministically (JSON null), so DENY receipts chain like any other.
 */
export function cabinetReceipt(prev, op, verdict, ctx = {}) {
  if (!verdict || typeof verdict.allowed !== "boolean" || !Array.isArray(verdict.fails)) {
    throw new Error("cabinet: receipt requires a cabinet verdict (fail closed)");
  }
  const body = {
    seq: ctx.seq,
    at: ctx.at,
    opDigest: sig8(op),
    allowed: verdict.allowed,
    reason: verdict.fails.length > 0 ? verdict.fails.join(",") : null,
    prevHash: prev ? prev.hash : null,
  };
  return { ...body, hash: sig8(body) };
}

/**
 * Zero-trust chain verification: seq monotonic from the first row, prevHash
 * linkage, and per-row hash recomputation. Tamper is located at the exact
 * index (brokenAt), never absorbed.
 */
export function verifyCabinetChain(receipts) {
  if (!Array.isArray(receipts)) return { ok: false, brokenAt: 0, reasons: ["not-an-array"] };
  const reasons = [];
  let prev = null;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const { hash, ...body } = r ?? {};
    const rowReasons = [];
    if (!r || typeof r !== "object") rowReasons.push(`#${i}:SHAPE`);
    else {
      if (typeof hash !== "string" || hash !== sig8(body)) rowReasons.push(`#${i}:SIG`);
      if (body.prevHash !== (prev ? prev.hash : null)) rowReasons.push(`#${i}:PREV`);
      if (prev && !(body.seq > prev.seq)) rowReasons.push(`#${i}:SEQ`);
      if (typeof body.allowed !== "boolean") rowReasons.push(`#${i}:VERDICT`);
    }
    if (rowReasons.length > 0) {
      reasons.push(...rowReasons);
      return { ok: false, brokenAt: i, reasons };
    }
    prev = r;
  }
  return { ok: true, brokenAt: null, reasons, count: receipts.length };
}

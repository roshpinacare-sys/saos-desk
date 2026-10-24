// saos-desk — Kelly-safe pre-trade risk kernel (directive §2, G71-2b)
// ============================================================================
// The SIZING half of the desk→dex risk wiring. saos-dex HFT grid soldiers
// (src/lib/dex/hft.ts, W49-c) size with an internal Kelly; the directive
// requires order payloads to route through SAOS-DESK pre-trade risk checks.
// This module is that desk kernel: classic Kelly f* = (b·p − q)/b with hard
// caps, integer-µ money, fail-closed gates, and a hash-linked receipt chain —
// exported as a pure, dependency-injected API the dex loop consumes through
// its contract adapter (dex re-declares the interface type only; the pinned
// KELLY_CONTRACT_VECTORS are the documented cross-repo drift detector).
//
// LAWS honored (LAWS.md):
//   · law 2  — pure module: no clock (DI zero-clock default; `at` from the
//              caller's state wins), no randomness, no network, no fs.
//   · law 3  — the mandate is hard law: every limit is DERIVED from
//              mandate@4 fields via kellyLimitsFromMandate; ad-hoc limits
//              are refused at the factory (no schema, no kernel).
//   · law 13 — units law: integers-only for MONEY (µ) crossing the signature;
//              fractions/probabilities are not money (validated floats).
//   · law 5  — receipts are append-only with a sig chain; tamper is measured,
//              never absorbed (verifyChain locates the exact index).
//   · law 12 spirit — zero look-ahead: a price stamped in the future is a
//              stale-price rejection, never silently accepted.
//
// Fail-closed gates (verdict ids, cabinet-record shape {id,label,passed,
// measured,limit} — one audit view reads both cabinets):
//   K1 kelly-unknown-asset   — empty/absent market/base/quote, bad side
//   K2 kelly-stale-price     — missing/zero/negative price, age > bound, future stamp
//   K3 kelly-no-edge         — measured edgeBps missing/zero/negative/non-integer
//   K4 kelly-no-bet          — Kelly f* ≤ 0 (the formula refuses the trade)
//   K5 kelly-slippage-stall  — measured spread beyond tolerance → zero stalls
//   K6 kelly-drawdown-halt   — drawdown beyond mandate halt → flat, everything
//   K7 kelly-bad-equity      — degenerate equity (non-integer/zero/negative)
// Clamp reasons (sized honestly, never sailed through):
//   kelly-cap-fraction       — raw deployed fraction above kellyCap → haircut to cap
//   kelly-cap-notional       — size above mandate notional cap → clamp to cap
//   kelly-sub-dust           — final size below the dust floor → REJECT (a stall is not a trade)

import { sig8 } from "./kernel.mjs";

export const KELLY_SCHEMA = "saos-desk/kelly@1";

/**
 * Capital-index base in µ — the SAME 10000bps index the dex cabinet uses
 * (src/cabinet.mjs CABINET_BASE_CAPITAL_MU): every limit is a mandate
 * percentage of this base, no invented absolute numbers.
 */
export const KELLY_BASE_CAPITAL_MU = 10_000_000;

/** Dust floor in µ — parity with saos-dex HFT_DUST_MU: below this the kernel REJECTs. */
export const KELLY_MIN_NOTIONAL_MU = 1000;

/** Fractional-Kelly haircut — quarter-Kelly, parity with saos-dex hft.ts KELLY_FRACTION. */
export const KELLY_FRACTION_HAIRCUT = 0.25;

/** Price freshness bound (ms) — beyond this the price input is stale, fail closed. */
export const KELLY_MAX_PRICE_AGE_MS = 5000;

/**
 * Kelly no-bet epsilon — |f*| at or below this is numerically zero (knife-edge
 * float noise, e.g. p=0.4/b=1.5 lands at ~5e-17): the kernel REFUSES to bet.
 */
export const KELLY_NO_BET_EPSILON = 1e-9;

/**
 * The desk's neutral prior for (p, b) when an order carries no measured
 * evidence: raw 1/3, quarter-Kelly 1/12 of equity — deliberately small.
 * Callers with measured stats (the dex loop's HftStats) MUST pass p/b; the
 * prior only keeps sizing deterministic when evidence is absent, and it
 * biases toward the SMALLEST honest position, never a bigger one.
 */
export const KELLY_PRIOR = Object.freeze({ p: 0.6, b: 1.5 });

/* ── mandate → limits (law 3: the mandate is hard law) ────────────────────── */

/**
 * Derives the kernel limits from a mandate@4 document. Throws on a mandate
 * that cannot feed the gate (fail closed). drawdownHaltPct is optional
 * (null → the drawdown gate records measured and passes, cabinet parity).
 * The signature covers ONLY the sourced fields — the dex side can pin this
 * value and prove it enforces the same mandate version.
 */
export function kellyLimitsFromMandate(mandate) {
  const L = mandate?.limits;
  if (!L || typeof L.kellyCap !== "number" || !Number.isFinite(L.kellyCap) || L.kellyCap <= 0 || L.kellyCap > 1) {
    throw new Error("kelly: mandate.limits.kellyCap missing or out of (0,1] (law 3 — fail closed)");
  }
  if (!L || typeof L.maxPositionPct !== "number" || !(L.maxPositionPct > 0)) {
    throw new Error("kelly: mandate.limits.maxPositionPct missing or invalid (law 3 — fail closed)");
  }
  const dd = L.drawdownHaltPct ?? null;
  if (dd !== null && (typeof dd !== "number" || !Number.isFinite(dd) || dd <= 0)) {
    throw new Error("kelly: mandate.limits.drawdownHaltPct invalid (law 3 — fail closed)");
  }
  return {
    schema: KELLY_SCHEMA,
    kellyCap: L.kellyCap,
    maxNotionalMu: Math.floor((KELLY_BASE_CAPITAL_MU * L.maxPositionPct) / 100),
    minNotionalMu: KELLY_MIN_NOTIONAL_MU,
    drawdownHaltPct: dd,
    mandateSig: sig8({
      kellyCap: L.kellyCap,
      maxPositionPct: L.maxPositionPct,
      drawdownHaltPct: dd,
    }),
  };
}

/* ── Kelly math (classic f* = (b·p − q)/b, integer-µ money) ───────────────── */

/** Raw Kelly fraction. Guards are the caller's job (see kellySizeMu). */
export function kellyRawFraction(p, b) {
  const q = 1 - p;
  return (b * p - q) / b;
}

/** Deployed fraction after the quarter-Kelly haircut and the kellyCap clamp. */
function deployedFraction(raw, kellyCap) {
  const uncapped = raw * KELLY_FRACTION_HAIRCUT;
  const frac = Math.min(Math.max(uncapped, 0), kellyCap);
  return { frac, fractionClamped: frac < uncapped };
}

/**
 * Kelly-safe integer size in µ against a limits doc (from kellyLimitsFromMandate).
 * Guards → 0: non-finite inputs, equity ≤ 0, f* ≤ epsilon (no bet), sub-dust result.
 * Throws on non-integer equity — integers-only money crossing the signature (law 13).
 * Clamps: fraction to kellyCap, size to maxNotionalMu.
 */
export function kellySizeMu(p, b, equityMu, limits) {
  if (!Number.isFinite(p) || !Number.isFinite(b) || !Number.isFinite(equityMu)) return 0;
  if (!Number.isInteger(equityMu)) throw new Error("kelly: equityMu must be an integer µ amount (law 13)");
  if (p <= 0 || p > 1 || b <= 0 || equityMu <= 0) return 0;
  const raw = kellyRawFraction(p, b);
  if (!Number.isFinite(raw) || raw <= KELLY_NO_BET_EPSILON) return 0;
  const { frac } = deployedFraction(raw, limits.kellyCap);
  const size = Math.floor(equityMu * frac);
  if (size > limits.maxNotionalMu) return limits.maxNotionalMu;
  if (size < limits.minNotionalMu) return 0; // a stall is not a trade
  return size;
}

/* ── verdict records (cabinet shape — one audit view reads both cabinets) ─── */

function verdict(id, label, passed, measured, limit) {
  return { id, label, passed, measured, limit };
}

/* ── the kernel factory (dependency-injected, clock-free) ─────────────────── */

const DECISIONS = ["APPROVE", "REJECT", "REDUCE"];

/**
 * createKellyKernel({ limits, clock }) — limits MUST come from
 * kellyLimitsFromMandate (no ad-hoc limits, law 3). clock is an optional
 * injected () => integer-ms; the default is the deterministic zero-clock and
 * state.at always wins over it (the caller owns time, law 2).
 */
export function createKellyKernel({ limits, clock } = {}) {
  if (!limits || limits.schema !== KELLY_SCHEMA) {
    throw new Error("kelly: limits must come from kellyLimitsFromMandate (law 3 — no ad-hoc limits)");
  }
  const frozenLimits = Object.freeze({ ...limits });

  const chain = [];
  let seq = 0;

  function receiptHash(body) {
    return sig8(body);
  }

  function pushReceipt(at, order, decision, sizeMu, reasons) {
    seq += 1;
    const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : null;
    const body = {
      seq,
      at,
      market: typeof order?.market === "string" ? order.market : null,
      decision,
      sizeMu,
      reasons,
      prevHash,
    };
    const rec = { ...body, hash: receiptHash(body) };
    chain.push(rec);
    return { ...rec };
  }

  /**
   * evaluateOrder(state, order) → { decision, sizeMu, reasons, verdicts, receipt }.
   * state: { at?, equityMu, drawdownPct } — the caller owns time and equity truth.
   * order: { market, base, quote, side, priceMu, priceAtMs, edgeBps,
   *          spreadBps?, slippageTolBps?, p?, b? } — p/b are the measured
   * Kelly evidence; absent → KELLY_PRIOR (documented conservative default).
   * Every decision — allow, reduce, deny — lands on the hash-linked receipt
   * chain (the cabinet law: allow AND deny both receipted).
   */
  function evaluateOrder(stateIn, order) {
    const verdicts = [];
    const fails = [];
    const s = stateIn ?? {};
    const o = order ?? {};

    const at = Number.isInteger(s.at) ? s.at : typeof clock === "function" ? clock() : 0;
    const atInt = Number.isInteger(at) ? at : 0;

    // K1 — identity/units: the asset must be known, the side legal.
    const assetOk =
      typeof o.market === "string" && o.market.length > 0 &&
      typeof o.base === "string" && o.base.length > 0 &&
      typeof o.quote === "string" && o.quote.length > 0 &&
      (o.side === "buy" || o.side === "sell");
    verdicts.push(
      verdict("K1", "הנכס-ידוע והצד חוקי (אין-נכס-אלמוני בשולחן)", assetOk,
        `${String(o.base ?? "?")}/${String(o.quote ?? "?")}/${String(o.side ?? "?")}`,
        "market+base+quote non-empty, side ∈ {buy,sell}"),
    );
    if (!assetOk) fails.push("kelly-unknown-asset");

    // K2 — freshness: a price that is missing, stale, or future-stamped is an
    // unfresh measurement — fail closed (two diagnostic ids under one gate:
    // kelly-missing-price for an absent/zero/negative price, kelly-stale-price
    // for a broken/old/future timestamp — a future stamp is a fake price,
    // zero look-ahead, desk law 12 spirit).
    const priceOk =
      typeof o.priceMu === "number" && Number.isInteger(o.priceMu) && o.priceMu > 0;
    const stampOk =
      typeof o.priceAtMs === "number" && Number.isInteger(o.priceAtMs);
    const age = priceOk && stampOk ? atInt - o.priceAtMs : null;
    const freshOk = priceOk && stampOk && age >= 0 && age <= KELLY_MAX_PRICE_AGE_MS;
    verdicts.push(
      verdict("K2", "מחיר-קיים וטרי (מחיר-עתיד = מחיר-מזויף — אין-הצצה-קדימה)",
        freshOk, !priceOk ? "missing-price" : `ageMs=${age}`, `0 ≤ age ≤ ${KELLY_MAX_PRICE_AGE_MS}ms`),
    );
    if (!priceOk) fails.push("kelly-missing-price");
    else if (!stampOk || age < 0 || age > KELLY_MAX_PRICE_AGE_MS) fails.push("kelly-stale-price");

    // K3 — measured edge: zero/negative edge is a stall, not a trade.
    const edgeOk = typeof o.edgeBps === "number" && Number.isInteger(o.edgeBps) && o.edgeBps > 0;
    verdicts.push(
      verdict("K3", "שולי-רווח נמדדים חיוביים (אפס-שוליים = עצירה)", edgeOk,
        String(o.edgeBps ?? "missing"), "edgeBps > 0"),
    );
    if (!edgeOk) fails.push("kelly-no-edge");

    // K5 — slippage stall: measured spread beyond tolerance → zero stalls.
    const spread = typeof o.spreadBps === "number" && Number.isInteger(o.spreadBps) ? o.spreadBps : null;
    const tol = typeof o.slippageTolBps === "number" && Number.isInteger(o.slippageTolBps) ? o.slippageTolBps : null;
    const stall = spread !== null && tol !== null && spread > tol;
    verdicts.push(
      verdict("K5", "מצב-עצירה: פער-נמדד ≤ סבילות (אפס-עצירות-החלקה)", !stall,
        spread === null ? "no-spread" : `spread=${spread}`, tol === null ? "no-tolerance" : `tol=${tol}`),
    );
    if (stall) fails.push("kelly-slippage-stall");

    // K6 — drawdown halt (mandate hard law): flat is the only answer.
    const dd = typeof s.drawdownPct === "number" && Number.isFinite(s.drawdownPct) && s.drawdownPct >= 0
      ? s.drawdownPct : null;
    const ddBreach = frozenLimits.drawdownHaltPct !== null &&
      (dd === null || dd > frozenLimits.drawdownHaltPct);
    verdicts.push(
      verdict("K6", "דריידאון ≤ הפסקת-המנדט (חריגה = שטוח, הכל נדחה)",
        !ddBreach, dd === null ? "unverified" : String(dd),
        frozenLimits.drawdownHaltPct === null ? "no-halt-configured" : String(frozenLimits.drawdownHaltPct)),
    );
    if (ddBreach) fails.push("kelly-drawdown-halt");

    // K7 — equity truth: degenerate equity is unverified state → fail closed.
    const equityOk = typeof s.equityMu === "number" && Number.isInteger(s.equityMu) && s.equityMu > 0;
    verdicts.push(
      verdict("K7", "הון-מדוד שלם-וחיובי (יחידות-µ, אין-שברים)", equityOk,
        String(s.equityMu ?? "missing"), "integer µ > 0"),
    );
    if (!equityOk) fails.push("kelly-bad-equity");

    // Measured Kelly evidence validation (p/b) — bad evidence is unverified state.
    const pIn = o.p ?? KELLY_PRIOR.p;
    const bIn = o.b ?? KELLY_PRIOR.b;
    const evidenceOk =
      Number.isFinite(pIn) && pIn > 0 && pIn <= 1 &&
      Number.isFinite(bIn) && bIn > 0;
    verdicts.push(
      verdict("K4e", "ראיות-קלי תקפות (p∈(0,1], b>0; חסר → עדיף-שמרני)", evidenceOk,
        `p=${String(pIn)} b=${String(bIn)}`, "finite, p∈(0,1], b>0"),
    );
    if (!evidenceOk) fails.push("kelly-bad-evidence");

    if (fails.length > 0) {
      const receipt = pushReceipt(atInt, o, "REJECT", 0, fails);
      return { decision: "REJECT", sizeMu: 0, reasons: fails, verdicts, receipt };
    }

    // Kelly sizing — the formula itself may refuse the bet.
    const raw = kellyRawFraction(pIn, bIn);
    if (!Number.isFinite(raw) || raw <= KELLY_NO_BET_EPSILON) {
      const receipt = pushReceipt(atInt, o, "REJECT", 0, ["kelly-no-bet"]);
      verdicts.push(
        verdict("K4", "שבר-קלי > 0 (הנוסחה עצמה מסרבת להימור)", false, String(raw), "> epsilon"),
      );
      return { decision: "REJECT", sizeMu: 0, reasons: ["kelly-no-bet"], verdicts, receipt };
    }

    const { frac, fractionClamped } = deployedFraction(raw, frozenLimits.kellyCap);
    let size = Math.floor(s.equityMu * frac);
    const reasons = [];
    if (fractionClamped) reasons.push("kelly-cap-fraction");
    if (size > frozenLimits.maxNotionalMu) {
      size = frozenLimits.maxNotionalMu;
      reasons.push("kelly-cap-notional");
    }
    if (size < frozenLimits.minNotionalMu) {
      const receipt = pushReceipt(atInt, o, "REJECT", 0, ["kelly-sub-dust"]);
      return { decision: "REJECT", sizeMu: 0, reasons: ["kelly-sub-dust"], verdicts, receipt };
    }

    verdicts.push(
      verdict("K4", "שבר-קלי ≤ תקרה (haircut רבע-קלי מוטמע)", true,
        `raw=${raw}`, `cap=${frozenLimits.kellyCap}`),
    );
    const decision = reasons.length > 0 ? "REDUCE" : "APPROVE";
    const receipt = pushReceipt(atInt, o, decision, size, reasons);
    return { decision, sizeMu: size, reasons, verdicts, receipt };
  }

  return {
    schema: KELLY_SCHEMA,
    limits: frozenLimits,
    evaluateOrder,
    receipts: () => chain.map((r) => ({ ...r })),
    verifyChain,
  };

  /** Zero-trust verification: prevHash linkage, monotonic seq, per-row sig recomputation. */
  function verifyChain(receipts = chain.map((r) => ({ ...r }))) {
    if (!Array.isArray(receipts)) return { ok: false, brokenAt: 0, reasons: ["not-an-array"] };
    let prev = null;
    for (let i = 0; i < receipts.length; i++) {
      const r = receipts[i];
      const rowReasons = [];
      if (!r || typeof r !== "object") rowReasons.push(`#${i}:SHAPE`);
      else {
        const { hash, ...body } = r;
        if (typeof hash !== "string" || hash !== receiptHash(body)) rowReasons.push(`#${i}:SIG`);
        if (body.prevHash !== (prev ? prev.hash : null)) rowReasons.push(`#${i}:PREV`);
        if (prev && !(body.seq > prev.seq)) rowReasons.push(`#${i}:SEQ`);
        if (!DECISIONS.includes(body.decision)) rowReasons.push(`#${i}:DECISION`);
      }
      if (rowReasons.length > 0) return { ok: false, brokenAt: i, reasons: rowReasons };
      prev = r;
    }
    return { ok: true, brokenAt: null, reasons: [], count: receipts.length };
  }
}

/* ── cross-repo contract vectors (the documented drift detector) ────────────
 * Deterministic input → expected-decision fixtures pinned HERE (the desk,
 * the kernel's home) and MIRRORED in saos-dex src/lib/dex/desk-kelly.ts.
 * The dex side never imports this module (separate repos — no shared
 * workspace): it re-declares the interface type and verifies any injected
 * kernel against these SAME vectors. A kernel that drifted (either repo)
 * fails conformance at boot — fail-closed, no quoting on drift.            */

const V_MANDATE = {
  schema: "saos-desk/mandate@4",
  limits: { maxPositionPct: 15, maxDailyLossPct: 2, kellyCap: 0.5, drawdownHaltPct: 10, volHaltPct: 2.5 },
};
const V_AT = 100_000;
const V_STATE = { at: V_AT, equityMu: 1_000_000, drawdownPct: 0 };
const V_ORDER = {
  market: "SAOS/USDS", base: "SAOS", quote: "USDS", side: "buy",
  priceMu: 2_000_000, priceAtMs: V_AT - 100, edgeBps: 70, spreadBps: 10, slippageTolBps: 50,
};
const V_CLONE = (x) => JSON.parse(JSON.stringify(x));

export const KELLY_CONTRACT_VECTORS = Object.freeze(
  [
    { name: "approve-center", mandate: V_MANDATE, state: V_STATE, order: V_ORDER, expect: { decision: "APPROVE", sizeMu: 83_333, reasons: [] } },
    { name: "reject-missing-price", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), priceMu: 0 }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-missing-price"] } },
    { name: "reject-future-price", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), priceAtMs: V_AT + 1 }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-stale-price"] } },
    { name: "reject-stale-price", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), priceAtMs: V_AT - KELLY_MAX_PRICE_AGE_MS - 1 }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-stale-price"] } },
    { name: "reject-unknown-asset", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), base: "" }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-unknown-asset"] } },
    { name: "reject-no-edge", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), edgeBps: 0 }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-no-edge"] } },
    { name: "reject-kelly-no-bet", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), p: 0.4, b: 1.5 }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-no-bet"] } },
    { name: "reject-slippage-stall", mandate: V_MANDATE, state: V_STATE, order: { ...V_CLONE(V_ORDER), spreadBps: 60, slippageTolBps: 50 }, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-slippage-stall"] } },
    { name: "reject-drawdown-halt", mandate: V_MANDATE, state: { ...V_CLONE(V_STATE), drawdownPct: 10.5 }, order: V_ORDER, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-drawdown-halt"] } },
    { name: "reject-bad-equity", mandate: V_MANDATE, state: { ...V_CLONE(V_STATE), equityMu: 1.5 }, order: V_ORDER, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-bad-equity"] } },
    { name: "reject-sub-dust", mandate: V_MANDATE, state: { ...V_CLONE(V_STATE), equityMu: 8_000 }, order: V_ORDER, expect: { decision: "REJECT", sizeMu: 0, reasons: ["kelly-sub-dust"] } },
    { name: "reduce-cap-notional", mandate: V_MANDATE, state: { ...V_CLONE(V_STATE), equityMu: 8_000_000 }, order: { ...V_CLONE(V_ORDER), p: 0.9, b: 3 }, expect: { decision: "REDUCE", sizeMu: 1_500_000, reasons: ["kelly-cap-notional"] } },
    { name: "reduce-cap-fraction", mandate: { schema: "saos-desk/mandate@4", limits: { maxPositionPct: 15, kellyCap: 0.05, drawdownHaltPct: 10 } }, state: V_STATE, order: V_ORDER, expect: { decision: "REDUCE", sizeMu: 50_000, reasons: ["kelly-cap-fraction"] } },
  ].map((v) => Object.freeze(v)),
);

/**
 * Runs the contract vectors against a kernel (or the shipped kernel when
 * none is passed). Returns { ok, count, failures: [{vector, reason}] }.
 * Compares decision + sizeMu + reasons-CONTAIN (never receipt hashes — the
 * sig8 chain is verified desk-side; the dex side compares decisions only).
 */
export function runContractVectors(kernel = null) {
  const failures = [];
  for (const v of KELLY_CONTRACT_VECTORS) {
    let k = kernel;
    if (!k) {
      let limits;
      try {
        limits = kellyLimitsFromMandate(v.mandate);
      } catch (e) {
        failures.push({ vector: v.name, reason: `limits-refused:${String(e instanceof Error ? e.message : e).slice(0, 80)}` });
        continue;
      }
      k = createKellyKernel({ limits });
    }
    let got;
    try {
      got = k.evaluateOrder(V_CLONE(v.state), V_CLONE(v.order));
    } catch (e) {
      failures.push({ vector: v.name, reason: `threw:${String(e instanceof Error ? e.message : e).slice(0, 80)}` });
      continue;
    }
    if (!got || got.decision !== v.expect.decision) {
      failures.push({ vector: v.name, reason: `decision:${String(got?.decision)}≠${v.expect.decision}` });
      continue;
    }
    if (v.expect.sizeMu !== undefined && got.sizeMu !== v.expect.sizeMu) {
      failures.push({ vector: v.name, reason: `sizeMu:${String(got.sizeMu)}≠${String(v.expect.sizeMu)}` });
      continue;
    }
    if (v.expect.reasons !== undefined) {
      const missing = v.expect.reasons.filter((r) => !(got.reasons ?? []).includes(r));
      if (missing.length > 0) {
        failures.push({ vector: v.name, reason: `reasons-missing:${missing.join(",")}` });
        continue;
      }
    }
  }
  return { ok: failures.length === 0, count: KELLY_CONTRACT_VECTORS.length, failures };
}

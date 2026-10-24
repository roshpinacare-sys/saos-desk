// saos-desk — Kelly-safe pre-trade risk kernel: TDD contract suite (G71-2b)
// ============================================================================
// Written BEFORE src/kelly.mjs (red-first law). Deterministic, offline, zero
// network, zero clock — `at` comes from the caller's state (desk law 2).
//
// Contract under test (directive §2 — "deterministic position sizing (Kelly
// criterion), zero slippage stalls, fail-closed security"):
//   · kellyLimitsFromMandate — mandate@4 is hard law (desk law 3); fail closed
//     on a mandate that cannot feed the gate.
//   · kellyRawFraction / kellySizeMu — classic Kelly f* = (b·p − q)/b in
//     integer-µ money (law 13: integers-only money; fractions are not money).
//   · createKellyKernel({limits, clock}) → evaluateOrder(state, order) →
//     { decision: APPROVE|REJECT|REDUCE, sizeMu, reasons, verdicts, receipt }.
//   · Fail-closed gates: unknown asset, missing/stale/future price, zero or
//     negative edge, kelly no-bet, cap breach → REDUCE (never sail through),
//     slippage stall, drawdown halt, sub-dust sizing.
//   · Every decision → hash-linked receipt (sig8, prevHash chain, monotonic
//     seq); verifyChain locates tamper at the exact index (law 5).
//   · KELLY_CONTRACT_VECTORS + runContractVectors — the cross-repo conformance
//     pin: saos-dex embeds the same vectors and may verify any injected kernel
//     against them (documented drift detector, no cross-repo import needed).

import { describe, test, expect } from "bun:test";
import {
  KELLY_SCHEMA,
  KELLY_BASE_CAPITAL_MU,
  KELLY_MIN_NOTIONAL_MU,
  KELLY_FRACTION_HAIRCUT,
  KELLY_MAX_PRICE_AGE_MS,
  kellyLimitsFromMandate,
  kellyRawFraction,
  kellySizeMu,
  createKellyKernel,
  KELLY_CONTRACT_VECTORS,
  runContractVectors,
} from "./kelly.mjs";

const MANDATE = {
  schema: "saos-desk/mandate@4",
  limits: {
    maxPositionPct: 15,
    maxDailyLossPct: 2,
    kellyCap: 0.5,
    drawdownHaltPct: 10,
    volHaltPct: 2.5,
  },
  positions: { maxOpenPositions: 5, tieLaw: "stop-wins" },
};

const LIMITS = kellyLimitsFromMandate(MANDATE);

// A valid order/state pair at `at = 100000` with a fresh price.
const AT = 100_000;
function state(over = {}) {
  return {
    at: AT,
    equityMu: 1_000_000,
    drawdownPct: 0,
    ...over,
  };
}
function order(over = {}) {
  return {
    market: "SAOS/USDS",
    base: "SAOS",
    quote: "USDS",
    side: "buy",
    priceMu: 2_000_000, // µ-quote per µ-base (2.0 in 4-decimal fixed point)
    priceAtMs: AT - 100, // 100ms old — fresh
    edgeBps: 70, // measured net edge after fees
    spreadBps: 10,
    slippageTolBps: 50,
    ...over,
  };
}

describe("kelly limits — mandate is hard law (law 3)", () => {
  test("derives limits from mandate@4 with cabinet-parity notional cap", () => {
    expect(LIMITS.schema).toBe(KELLY_SCHEMA);
    expect(LIMITS.kellyCap).toBe(0.5);
    expect(LIMITS.maxNotionalMu).toBe(Math.floor((KELLY_BASE_CAPITAL_MU * 15) / 100));
    expect(LIMITS.maxNotionalMu).toBe(1_500_000);
    expect(LIMITS.minNotionalMu).toBe(KELLY_MIN_NOTIONAL_MU);
    expect(LIMITS.drawdownHaltPct).toBe(10);
    expect(typeof LIMITS.mandateSig).toBe("string");
    expect(LIMITS.mandateSig.length).toBe(8);
  });

  test("throws on mandate missing kellyCap (fail closed)", () => {
    expect(() => kellyLimitsFromMandate({ limits: { maxPositionPct: 15 } })).toThrow();
  });

  test("throws on mandate missing maxPositionPct (fail closed)", () => {
    expect(() => kellyLimitsFromMandate({ limits: { kellyCap: 0.5 } })).toThrow();
  });

  test("throws on kellyCap out of (0,1] (fail closed)", () => {
    expect(() => kellyLimitsFromMandate({ limits: { maxPositionPct: 15, kellyCap: 0 } })).toThrow();
    expect(() => kellyLimitsFromMandate({ limits: { maxPositionPct: 15, kellyCap: 1.5 } })).toThrow();
    expect(() => kellyLimitsFromMandate({ limits: { maxPositionPct: 15, kellyCap: "0.5" } })).toThrow();
  });
});

describe("kelly math — f* = (b·p − q)/b, integer-µ money", () => {
  test("classic fractions", () => {
    expect(kellyRawFraction(0.6, 1.5)).toBeCloseTo(1 / 3, 12);
    expect(kellyRawFraction(0.55, 2)).toBeCloseTo(0.325, 12);
    expect(kellyRawFraction(0.9, 3)).toBeCloseTo(2.6 / 3, 12);
    // knife-edge no-bet: algebraically f*=0 — float noise is bounded at ~1e-16
    // (the kernel refuses anything ≤ KELLY_NO_BET_EPSILON = 1e-9)
    expect(Math.abs(kellyRawFraction(0.4, 1.5))).toBeLessThan(1e-12);
    expect(kellyRawFraction(0.3, 1.5)).toBeLessThan(0); // negative edge
  });

  test("size vectors — quarter-Kelly haircut, floor to integer µ", () => {
    // raw 1/3 × 0.25 = 1/12 → floor(1e6/12) = 83333
    expect(kellySizeMu(0.6, 1.5, 1_000_000, LIMITS)).toBe(83_333);
    // raw 0.325 × 0.25 = 0.08125 → floor(2e6 × 0.08125) = 162500
    expect(kellySizeMu(0.55, 2, 2_000_000, LIMITS)).toBe(162_500);
  });

  test("guards — never trade a negative edge, no evidence, or degenerate input", () => {
    expect(kellySizeMu(0.4, 1.5, 1_000_000, LIMITS)).toBe(0); // f*=0
    expect(kellySizeMu(0.3, 1.5, 1_000_000, LIMITS)).toBe(0); // f*<0
    expect(kellySizeMu(0, 1.5, 1_000_000, LIMITS)).toBe(0);
    expect(kellySizeMu(0.6, 0, 1_000_000, LIMITS)).toBe(0); // no odds → no evidence
    expect(kellySizeMu(0.6, 1.5, 0, LIMITS)).toBe(0);
    expect(kellySizeMu(0.6, 1.5, -5, LIMITS)).toBe(0);
    expect(kellySizeMu(NaN, 1.5, 1_000_000, LIMITS)).toBe(0);
    expect(kellySizeMu(Infinity, 1.5, 1_000_000, LIMITS)).toBe(0);
    expect(kellySizeMu(0.6, NaN, 1_000_000, LIMITS)).toBe(0);
  });

  test("fraction clamp at kellyCap and notional cap — REDUCE territory", () => {
    // p=0.9 b=3: raw 2.6/3, ×0.25 = 0.21667 ≤ 0.5 → no fraction clamp,
    // but 8e6 × 0.21667 = 1_733_333 > 1.5M notional cap → clamped to 1.5M.
    expect(kellySizeMu(0.9, 3, 8_000_000, LIMITS)).toBe(1_500_000);
  });

  test("sub-dust sizing is zero (a stall is not a trade)", () => {
    // 8_000 × (1/12) = 666.67 → floor 666 < 1000 → 0
    expect(kellySizeMu(0.6, 1.5, 8_000, LIMITS)).toBe(0);
  });

  test("integers-only money crossing the signature (law 13)", () => {
    expect(() => kellySizeMu(0.6, 1.5, 1_000_000.5, LIMITS)).toThrow();
    expect(() => kellySizeMu(0.6, 1.5, 1_000_000.0, LIMITS)).not.toThrow();
  });
});

describe("createKellyKernel — evaluateOrder fail-closed gates", () => {
  test("APPROVE — fresh price, positive edge, clean kelly size", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const r = k.evaluateOrder(state(), order());
    expect(r.decision).toBe("APPROVE");
    expect(r.sizeMu).toBe(83_333); // equity 1e6 × (raw 1/3 × 0.25)
    expect(r.reasons).toEqual([]);
    expect(r.receipt.decision).toBe("APPROVE");
    expect(r.receipt.sizeMu).toBe(83_333);
    expect(r.receipt.seq).toBe(1);
  });

  test("REJECT — missing price (priceMu absent/zero/negative)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    for (const priceMu of [undefined, 0, -3]) {
      const r = k.evaluateOrder(state(), order({ priceMu }));
      expect(r.decision).toBe("REJECT");
      expect(r.sizeMu).toBe(0);
      expect(r.reasons).toContain("kelly-missing-price");
    }
  });

  test("REJECT — stale price beyond KELLY_MAX_PRICE_AGE_MS", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const r = k.evaluateOrder(state(), order({ priceAtMs: AT - KELLY_MAX_PRICE_AGE_MS - 1 }));
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toContain("kelly-stale-price");
    // boundary: exactly at the age bound is fresh (inclusive)
    const okR = k.evaluateOrder(state(), order({ priceAtMs: AT - KELLY_MAX_PRICE_AGE_MS }));
    expect(okR.decision).toBe("APPROVE");
  });

  test("REJECT — future price timestamp (zero look-ahead, desk law 12 spirit)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const r = k.evaluateOrder(state(), order({ priceAtMs: AT + 1 }));
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toContain("kelly-stale-price");
  });

  test("REJECT — unknown/absent asset", () => {
    const k = createKellyKernel({ limits: LIMITS });
    for (const over of [{ base: "" }, { base: undefined }, { quote: "" }, { market: "" }]) {
      const r = k.evaluateOrder(state(), order(over));
      expect(r.decision).toBe("REJECT");
      expect(r.reasons).toContain("kelly-unknown-asset");
    }
  });

  test("REJECT — zero or negative measured edge", () => {
    const k = createKellyKernel({ limits: LIMITS });
    for (const edgeBps of [0, -5, undefined, 1.5]) {
      const r = k.evaluateOrder(state(), order({ edgeBps }));
      expect(r.decision).toBe("REJECT");
      expect(r.reasons).toContain("kelly-no-edge");
    }
  });

  test("REJECT — kelly no-bet (edge measured but Kelly says f* ≤ 0)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    // kernel computes its own p/b from the desk stats contract: 0.4/1.5 → f*=0
    const r = k.evaluateOrder(state(), order({ p: 0.4, b: 1.5 }));
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toContain("kelly-no-bet");
    expect(r.sizeMu).toBe(0);
  });

  test("REJECT — slippage stall (spread beyond tolerance → zero stalls)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const r = k.evaluateOrder(state(), order({ spreadBps: 60, slippageTolBps: 50 }));
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toContain("kelly-slippage-stall");
    // boundary: spread == tolerance passes (inclusive), and missing spread/tolerance = no stall gate
    expect(k.evaluateOrder(state(), order({ spreadBps: 50, slippageTolBps: 50 })).decision).toBe("APPROVE");
    expect(k.evaluateOrder(state(), order({ spreadBps: undefined })).decision).toBe("APPROVE");
  });

  test("REJECT — drawdown halt (mandate hard law — flat is the only answer)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const r = k.evaluateOrder(state({ drawdownPct: 10.5 }), order());
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toContain("kelly-drawdown-halt");
    // boundary: exactly at halt pct passes
    expect(k.evaluateOrder(state({ drawdownPct: 10 }), order()).decision).toBe("APPROVE");
  });

  test("REJECT — degenerate equity (non-integer, zero, negative)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    for (const equityMu of [0, -1, 1.5, undefined, NaN]) {
      const r = k.evaluateOrder(state({ equityMu }), order());
      expect(r.decision).toBe("REJECT");
      expect(r.sizeMu).toBe(0);
    }
  });

  test("REDUCE — notional cap breach clamps size, never sails through", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const r = k.evaluateOrder(state({ equityMu: 8_000_000 }), order({ p: 0.9, b: 3 }));
    expect(r.decision).toBe("REDUCE");
    expect(r.sizeMu).toBe(1_500_000);
    expect(r.reasons).toContain("kelly-cap-notional");
    expect(r.receipt.sizeMu).toBe(1_500_000);
  });

  test("REDUCE — raw fraction above kellyCap is haircut-clamped with reason", () => {
    const k = createKellyKernel({ limits: LIMITS });
    // p=0.9 b=1.5 → raw = (1.35−0.1)/1.5 = 0.8333, ×0.25 = 0.2083 ≤ 0.5 → no.
    // Force a fraction breach: pass the cap low via a custom limits doc.
    const lowCap = kellyLimitsFromMandate({
      limits: { maxPositionPct: 15, kellyCap: 0.05, drawdownHaltPct: 10 },
    });
    const k2 = createKellyKernel({ limits: lowCap });
    // raw 1/3 × 0.25 = 0.0833 > 0.05 → clamped fraction 0.05 → 1e6 × 0.05 = 50_000
    const r = k2.evaluateOrder(state(), order());
    expect(r.decision).toBe("REDUCE");
    expect(r.sizeMu).toBe(50_000);
    expect(r.reasons).toContain("kelly-cap-fraction");
  });

  test("kernel is dependency-injected and clock-free: state.at wins, zero-clock default", () => {
    const k = createKellyKernel({ limits: LIMITS }); // no clock → deterministic 0
    const r0 = k.evaluateOrder({ at: 0, equityMu: 1_000_000, drawdownPct: 0 }, order({ priceAtMs: 0 }));
    expect(r0.decision).toBe("APPROVE");
    const kClock = createKellyKernel({ limits: LIMITS, clock: () => 7_777 });
    const rC = kClock.evaluateOrder({ equityMu: 1_000_000, drawdownPct: 0 }, order({ priceAtMs: 7_677 })); // 100ms old vs clock
    expect(rC.decision).toBe("APPROVE");
    expect(rC.receipt.at).toBe(7_777);
  });

  test("kernel refuses to run without cabinet-grade limits (no ad-hoc limits)", () => {
    expect(() => createKellyKernel({ limits: { kellyCap: 0.5 } })).toThrow();
    expect(() => createKellyKernel({})).toThrow();
    expect(() => createKellyKernel({ limits: { ...LIMITS, schema: "forged@9" } })).toThrow();
  });
});

describe("receipts — hash-linked, tamper-located (law 5)", () => {
  test("chain links prevHash and monotonic seq across decisions", () => {
    const k = createKellyKernel({ limits: LIMITS });
    k.evaluateOrder(state(), order()); // 1 APPROVE
    k.evaluateOrder(state(), order({ edgeBps: 0 })); // 2 REJECT
    k.evaluateOrder(state({ equityMu: 8_000_000 }), order({ p: 0.9, b: 3 })); // 3 REDUCE
    const rs = k.receipts();
    expect(rs.length).toBe(3);
    expect(rs.map((r) => r.decision)).toEqual(["APPROVE", "REJECT", "REDUCE"]);
    expect(rs[0].prevHash).toBe(null);
    expect(rs[1].prevHash).toBe(rs[0].hash);
    expect(rs[2].prevHash).toBe(rs[1].hash);
    expect(rs[2].seq).toBeGreaterThan(rs[1].seq);
    const v = k.verifyChain();
    expect(v.ok).toBe(true);
    expect(v.brokenAt).toBe(null);
  });

  test("tamper is located at the exact index, never absorbed", () => {
    const k = createKellyKernel({ limits: LIMITS });
    k.evaluateOrder(state(), order());
    k.evaluateOrder(state(), order({ edgeBps: 0 }));
    const rs = k.receipts();
    rs[0].sizeMu = 999_999_999; // forge history
    const v = k.verifyChain(rs);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
  });

  test("receipts are defensive copies — the live chain cannot be mutated by callers", () => {
    const k = createKellyKernel({ limits: LIMITS });
    k.evaluateOrder(state(), order());
    const snapshot = JSON.stringify(k.receipts());
    const rs = k.receipts();
    rs[0].decision = "FORGED";
    expect(JSON.stringify(k.receipts())).toBe(snapshot);
  });
});

describe("cross-repo contract vectors — the documented drift detector", () => {
  test("vectors are frozen and cover the fail-closed gate set", () => {
    expect(Object.isFrozen(KELLY_CONTRACT_VECTORS)).toBe(true);
    expect(KELLY_CONTRACT_VECTORS.length).toBeGreaterThanOrEqual(12);
    const names = new Set(KELLY_CONTRACT_VECTORS.map((v) => v.name));
    for (const g of [
      "approve-center",
      "reject-missing-price",
      "reject-stale-price",
      "reject-unknown-asset",
      "reject-no-edge",
      "reject-kelly-no-bet",
      "reject-slippage-stall",
      "reject-drawdown-halt",
      "reduce-cap-notional",
      "reduce-cap-fraction",
    ]) {
      expect(names.has(g)).toBe(true);
    }
  });

  test("runContractVectors — the shipped kernel conforms to its own vectors", () => {
    const res = runContractVectors();
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.count).toBe(KELLY_CONTRACT_VECTORS.length);
  });

  test("runContractVectors detects a drifted kernel (positive control)", () => {
    const k = createKellyKernel({ limits: LIMITS });
    const forged = {
      schema: k.schema,
      limits: k.limits,
      evaluateOrder: () => ({ decision: "APPROVE", sizeMu: 1, reasons: [], verdicts: [], receipt: null }),
    };
    const res = runContractVectors(forged);
    expect(res.ok).toBe(false);
    expect(res.failures.length).toBeGreaterThan(0);
  });
});

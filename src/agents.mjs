// saos-desk agents — the cabinet specialists (R338)
// Pure functions: snapshot + mandate + weight -> verdict. No clock/random/network/fs.
// Each verdict: { id, name, action, confidence, reasons[], weight }
import { clamp, round4, hash32 } from "./kernel.mjs";

export const AGENTS = [
  { id: "technical", name: "הטכני" },
  { id: "valuation", name: "הערכת-השווי" },
  { id: "momentum", name: "המומנטום" },
  { id: "sentiment", name: "הסנטימנט" },
  { id: "risk", name: "הסיכונים" },
];

export function verdict(agentId, snap, mandate, weights) {
  const weight = weights?.[agentId]?.weight ?? 1;
  const L = mandate.limits;
  switch (agentId) {
    case "technical": {
      const reasons = [];
      const r = snap.rsi14;
      const above = snap.price >= snap.sma50;
      reasons.push(`RSI14=${r} · מחיר ${above ? "מעל" : "מתחת"} SMA50=${snap.sma50} · מגמה=${snap.trendScore}`);
      if (r <= 30 && above) return { agentId, name: "הטכני", action: "buy", confidence: clamp(0.55 + (30 - r) / 100 + Math.abs(snap.trendScore) * 0.2, 0, 1), reasons, weight };
      if (r >= 70 && !above) return { agentId, name: "הטכני", action: "sell", confidence: clamp(0.55 + (r - 70) / 100 + Math.abs(snap.trendScore) * 0.2, 0, 1), reasons, weight };
      if (snap.trendScore >= 0.45) return { agentId, name: "הטכני", action: "buy", confidence: 0.5 + snap.trendScore * 0.2, reasons, weight };
      if (snap.trendScore <= -0.45) return { agentId, name: "הטכני", action: "sell", confidence: 0.5 + Math.abs(snap.trendScore) * 0.2, reasons, weight };
      return { agentId, name: "הטכני", action: "hold", confidence: 0.5, reasons, weight };
    }
    case "valuation": {
      const mid = (snap.sma20 + snap.sma50) / 2;
      const z = snap.volPct > 0 ? (snap.price - mid) / (snap.atr14 * 2) : 0; // price in ATR units from fair band
      const reasons = [`מחיר ${snap.price} מול פס-הוגן ${round4(mid)} (z=${round4(z)})`];
      if (z <= -1) return { agentId, name: "הערכת-השווי", action: "buy", confidence: clamp(0.5 + Math.min(0.3, -z * 0.2), 0, 1), reasons, weight };
      if (z >= 1) return { agentId, name: "הערכת-השווי", action: "sell", confidence: clamp(0.5 + Math.min(0.3, z * 0.2), 0, 1), reasons, weight };
      return { agentId, name: "הערכת-השווי", action: "hold", confidence: 0.5, reasons, weight };
    }
    case "momentum": {
      const c = snap.bars.map((b) => b.c);
      const n = c.length;
      const r10 = n >= 11 ? (c[n - 1] / c[n - 11] - 1) * 100 : 0;
      const reasons = [`תשואה 10-נרות=${round4(r10)}% · משטר=${snap.regime}`];
      if (r10 >= 3 && snap.regime !== "choppy-highvol") return { agentId, name: "המומנטום", action: "buy", confidence: clamp(0.5 + Math.min(0.35, r10 / 20), 0, 1), reasons, weight };
      if (r10 <= -3 && snap.regime !== "choppy-highvol") return { agentId, name: "המומנטום", action: "sell", confidence: clamp(0.5 + Math.min(0.35, -r10 / 20), 0, 1), reasons, weight };
      return { agentId, name: "המומנטום", action: "hold", confidence: 0.5, reasons, weight };
    }
    case "sentiment": {
      // deterministic pseudo-sentiment per (symbol, seed) — HONEST: sim only here.
      // The live Hebrew RSS adapter (Calcalist/Globes/TheMarker) lives in data.mjs,
      // outside the pure core; the cycle stamps its real status on the artifact.
      const s = ((hash32(snap.symbol + "|" + snap.seed) % 201) - 100) / 100;
      const reasons = [`ציון-סנטימנט (סימולציה)=${round4(s)} · ערוצי-עברית: ${mandate.hebrewFeeds.map((f) => f.name).join(", ")}`];
      if (s >= 0.25) return { agentId, name: "הסנטימנט", action: "buy", confidence: 0.4 + 0.3 * s, reasons, weight };
      if (s <= -0.25) return { agentId, name: "הסנטימנט", action: "sell", confidence: 0.4 + 0.3 * Math.abs(s), reasons, weight };
      return { agentId, name: "הסנטימנט", action: "hold", confidence: 0.45, reasons, weight };
    }
    case "risk": {
      const reasons = [];
      if (snap.volPct > L.volHaltPct) {
        reasons.push(`תנודתיות ${snap.volPct}% מעל סף ${L.volHaltPct}% — וטו-חשיפה`);
        return { agentId, name: "הסיכונים", action: "sell", confidence: 0.8, reasons, weight };
      }
      if (Math.abs(snap.trendScore) < 0.15) {
        reasons.push(`אין כיוון (מגמה=${snap.trendScore}) — מומלץ הימנעות`);
        return { agentId, name: "הסיכונים", action: "hold", confidence: 0.6, reasons, weight };
      }
      if (snap.trendScore <= -0.45) {
        reasons.push("מגמה יורדת חדה — הגנה בצד הקצר");
        return { agentId, name: "הסיכונים", action: "sell", confidence: 0.55, reasons, weight };
      }
      reasons.push(`תנודתיות ${snap.volPct}% בתוך הסף · מגמה=${snap.trendScore}`);
      return { agentId, name: "הסיכונים", action: snap.trendScore >= 0.45 ? "buy" : "hold", confidence: 0.5 + Math.max(0, snap.trendScore) * 0.2, reasons, weight };
    }
    default:
      return { agentId, name: agentId, action: "hold", confidence: 0.5, reasons: [], weight };
  }
}

export function cabinet(snap, mandate, weights) {
  return AGENTS.map((a) => verdict(a.id, snap, mandate, weights));
}

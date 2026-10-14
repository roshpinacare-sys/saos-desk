// saos-desk reflexivity — Darwinian weight evolution (R338)
// Pure: (verdicts, chair decision, realizedPct) -> weight deltas, bounded [0.5, 2.0].
// Agents aligned with a profitable decision gain; aligned with a losing one lose.
// Unaligned agents (hold/flat or direction-neutral) stay untouched — honest zeros.
import { clamp, round4 } from "./kernel.mjs";

export function evolve(weights0, agents, decision, sizePct, realizedPct) {
  const weights = JSON.parse(JSON.stringify(weights0));
  const frac = sizePct / 100;
  const tradePnl = frac > 0 ? realizedPct / frac : 0; // per-unit-of-position return
  const perAgent = [];
  for (const v of agents) {
    const w0 = weights[v.agentId]?.weight ?? 1;
    const entry = weights[v.agentId] ?? { weight: w0, wins: 0, losses: 0 };
    const aligned = (v.action === decision) && (decision === "buy" || decision === "sell");
    let pnl = 0;
    if (aligned && frac > 0) {
      // buy-aligned agents earn tradePnl; sell-aligned agents earn the short side (-tradePnl)
      pnl = v.action === "buy" ? tradePnl : -tradePnl;
    }
    const factor = 1 + 0.25 * Math.tanh(4 * pnl);
    const w1 = clamp(w0 * factor, 0.5, 2.0);
    entry.weight = round4(w1);
    if (pnl > 0.001) entry.wins += 1;
    else if (pnl < -0.001) entry.losses += 1;
    weights[v.agentId] = entry;
    perAgent.push({ agentId: v.agentId, aligned, pnl: round4(pnl), factor: round4(factor), weightBefore: w0, weightAfter: entry.weight });
  }
  return { weights, perAgent };
}

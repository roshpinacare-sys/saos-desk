// saos-desk shared types (R338 port) — client-safe, no node imports here.
// The engine lives in engine.ts (server-only: node:crypto for sig8).

export type Rng = () => number;

export type AgentId = "technical" | "valuation" | "momentum" | "sentiment" | "risk";

export type AgentAction = "buy" | "hold" | "sell";

export type Decision = "buy" | "sell" | "flat";

export type Regime = "trend-up" | "trend-down" | "choppy-highvol" | "choppy-lowvol";

export interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Snapshot {
  seed: number;
  symbol: string;
  klass: string;
  bars: Bar[];
  price: number;
  atr14: number;
  rsi14: number;
  sma20: number;
  sma50: number;
  trendScore: number;
  volPct: number;
  regime: Regime;
  source: "sim";
  /** sim close-out window (used ONLY by simOutcome — agents never see it) */
  _forward: Bar[];
}

export interface Verdict {
  agentId: AgentId;
  name: string;
  action: AgentAction;
  confidence: number;
  reasons: string[];
  weight: number;
}

export interface MandateLimits {
  maxPositionPct: number;
  maxDailyLossPct: number;
  kellyCap: number;
  drawdownHaltPct: number;
  volHaltPct: number;
}

export interface MandateQuorum {
  minConfidence: number;
  minWeightedScore: number;
  rounds: number;
}

export interface MandateIngest {
  schema: string;
  publicEndpointsOnly: boolean;
  keysAllowed: boolean;
  timeoutMs: number;
  maxBytes: number;
  maxRssItems: number;
  minAliveRatio: number;
  anomalyMovePct: number;
  freshnessMaxMin: number;
  quoteHosts: string[];
  hebrewNews: { name: string; url: string }[];
}

export interface Mandate {
  schema: string;
  execution: { mode: "paper" | "live"; liveOwnerArmed: boolean };
  limits: MandateLimits;
  quorum: MandateQuorum;
  universe: { tase: string[]; global: string[] };
  hebrewFeeds: { name: string; url: string }[];
  ingest: MandateIngest;
}

export interface AgentWeightEntry {
  weight: number;
  wins: number;
  losses: number;
}

/** GET /api/desk/feeds response (R345 live artery) — mirrors the sealed feed-state shape. */
export interface FeedsResponse {
  ok: boolean;
  probedAt: string;
  verdict: "ALIVE" | "REFRAIN";
  ratio: number;
  alive: number;
  dead: number;
  anomalies: number;
  reasons: string[];
  symbols: {
    symbol: string;
    verdict: "ALIVE" | "DEAD" | "ANOMALY";
    last?: number;
    changePct?: number;
    reason?: string;
  }[];
  screening: {
    quotesProbed: number;
    newsFeedsProbed: number;
    injectionDrops: number;
    malformedDrops: number;
  };
  headlines: {
    feed: string;
    ok: boolean;
    reason?: string;
    stats?: { droppedInjection?: number; droppedMalformed?: number };
    items: { title: string; link: string | null; date: string | null }[];
  }[];
  keyless: boolean;
  cached?: boolean;
}

export type Weights = Record<string, AgentWeightEntry>;

export interface RiskCheck {
  id: string;
  label: string;
  passed: boolean;
  measured: string;
  limit: string;
}

export interface RiskGateResult {
  passed: boolean;
  checks: RiskCheck[];
}

export interface DebateStatement {
  agentId: AgentId;
  stance: AgentAction;
  argument: string;
}

export interface DebateRound {
  round: number;
  statements: DebateStatement[];
}

export interface ChairResult {
  decision: Decision;
  sizePct: number;
  confidence: number;
  quorumPassed: boolean;
  notes: string[];
}

export interface Outcome {
  realizedPct: number;
  simClosed: boolean;
}

export interface WeightDelta {
  agentId: AgentId;
  aligned: boolean;
  pnl: number;
  factor: number;
  weightBefore: number;
  weightAfter: number;
}

/** The full session artifact — mirrors repos/saos-desk/src/cycle.mjs (saos-desk/session@1). */
export interface DeskArtifact {
  schema: "saos-desk/session@1";
  seed: number;
  beat: number;
  symbol: string;
  klass: string;
  regime: Regime;
  market: {
    price: number;
    atr14: number;
    rsi14: number;
    sma20: number;
    sma50: number;
    trendScore: number;
    volPct: number;
    source: string;
    /** [o, h, l, c] per bar — 120 seen bars */
    bars: number[][];
  };
  dataMode: string;
  feed?: {
    verdict: string;
    refrain: boolean;
    reason: string | null;
  };
  agents: Verdict[];
  debate: DebateRound[];
  chair: ChairResult;
  riskGate: RiskGateResult;
  outcome: Outcome;
  weightsAfter: WeightDelta[];
  mandate: {
    execution: string;
    maxPositionPct: number;
    volHaltPct: number;
  };
  at: string | null;
  prevSig?: string;
  sig?: string;
}

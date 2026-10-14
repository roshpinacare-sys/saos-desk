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
  /** sim path: the PRNG seed; live-bars path (R353): null — the market generated these bars */
  seed: number | null;
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
  source: "sim" | "live-bars";
  /** close-out window — sim path: PRNG fixture; live-bars path: REAL next-bars (agents never see it) */
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

export interface MandateMarketData {
  schema: string;
  realBarsRequired: boolean;
  decisionBars: number;
  forwardMax: number;
  minBars: number;
  barRange: string;
  law: string;
}

export interface Mandate {
  schema: string;
  execution: { mode: "paper" | "live"; liveOwnerArmed: boolean };
  limits: MandateLimits;
  quorum: MandateQuorum;
  positions: MandatePositions;
  universe: { tase: string[]; global: string[] };
  hebrewFeeds: { name: string; url: string }[];
  marketData: MandateMarketData;
  ingest: MandateIngest;
}

export interface MandatePositions {
  schema: string;
  paperOnly: boolean;
  stopAtrMult: number;
  rrTarget: number;
  timeStopBars: number;
  maxOpenPositions: number;
  maxGrossExposurePct: number;
  varConfidence: number;
  varLookbackBars: number;
  cooldownBars: number;
  tieLaw: string;
}

export interface AgentWeightEntry {
  weight: number;
  wins: number;
  losses: number;
}

/** GET /api/desk/positions response (R346 paper book) — the engine room. */
export interface PositionsResponse {
  ok: boolean;
  positions: DeskPositionRow[];
  portfolio: {
    openCount: number;
    closedCount: number;
    grossExposurePct: number;
    netExposurePct: number;
    unrealizedPct: number;
    realizedPct: number;
    hitRate: number | null;
    drawdownPct: number;
  };
  var: { ok: boolean; reason?: string; varPct?: number | null; confidence?: number; samples?: number };
  marks: { symbol: string; ok: boolean; last: number | null; reason: string | null }[];
  paperOnly: boolean;
}

export interface DeskPositionRow {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  sizePct: number;
  status: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPerUnit: number;
  atrAtEntry: number;
  barsHeld: number;
  lastMarkT: number;
  lastMark: number;
  unrealizedPct: number;
  exitPrice?: number | null;
  realizedPct?: number | null;
  closeReason?: string | null;
  openedAt: string;
  closedAt?: string | null;
  events?: { type: string; at: string | null; price: number }[];
}

/** GET /api/desk/backtest response (R346) — real bars, lookahead-free engine. */
export interface BacktestResponse {
  ok: boolean;
  symbol: string;
  range: string;
  bars?: number;
  stats?: {
    tradeCount: number;
    hitRate: number | null;
    avgWinPct: number | null;
    avgLossPct: number | null;
    profitFactor: number | null;
    totalReturnPct: number;
    sharpe: number | null;
    maxDrawdownPct: number;
    entryRule: string;
    exitRule: string;
  };
  equity?: number[];
  trades?: {
    side: string;
    entryPrice: number;
    exitPrice: number;
    realizedPct: number;
    closeReason: string;
    barsHeld: number;
    signal: string | null;
  }[];
  sig?: string;
  cached?: boolean;
  message?: string;
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

/** GET /api/desk/ledger response (R350 sovereign book) — DeFi records for chair decisions. */
export interface LedgerEntryRow {
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

export interface LedgerResponse {
  ok: boolean;
  schema: string;
  chain: { ok: boolean; count: number; brokenAt: number | null; reasons: string[] };
  entries: LedgerEntryRow[];
  paperOnly: boolean;
}

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
  /** R353: live-bars path — no forward real bar yet = pending, honest zeros, never fabricated */
  pending?: boolean;
  /** R353: "measured-next-bar" | "awaiting-next-real-bar" — absent on the sim fixture path */
  outcomeSource?: string;
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

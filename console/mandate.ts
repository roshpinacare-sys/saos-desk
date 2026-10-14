// saos-desk mandate — the hard law, copied numbers-exact from repos/saos-desk/mandate.json (R338)
// Plus the universe with Hebrew display names from repos/saos-desk/src/data.mjs,
// and the cabinet roster (client-safe data — no node imports here).
import type { AgentId, Mandate } from "./types";

export const MANDATE: Mandate = {
  schema: "saos-desk/mandate@2",
  execution: {
    mode: "paper",
    liveOwnerArmed: false,
  },
  limits: {
    maxPositionPct: 15,
    maxDailyLossPct: 2,
    kellyCap: 0.5,
    drawdownHaltPct: 10,
    volHaltPct: 2.5,
  },
  quorum: {
    minConfidence: 0.55,
    minWeightedScore: 0.35,
    rounds: 3,
  },
  universe: {
    tase: ["LEUMI.TA", "FIBI.TA", "POLI.TA", "NICE.TA", "TEVA.TA", "ICL.TA", "ESLT.TA", "BEZQ.TA", "MZTF.TA", "DSEA.TA"],
    global: ["SPY", "QQQ", "BTC-USD"],
  },
  hebrewFeeds: [
    { name: "Calcalist", url: "https://www.calcalist.co.il/AllNews.xml" },
    { name: "Globes", url: "https://www.globes.co.il/webservice/rss/rss_feeds_rss20.xml?fid=1042" },
    { name: "TheMarker", url: "https://www.themarker.com/cserver/rss/allnews" },
  ],
  ingest: {
    schema: "saos-desk/ingest@1",
    publicEndpointsOnly: true,
    keysAllowed: false,
    timeoutMs: 8000,
    maxBytes: 262144,
    maxRssItems: 12,
    minAliveRatio: 0.7,
    anomalyMovePct: 12,
    freshnessMaxMin: 90,
    quoteHosts: ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"],
    hebrewNews: [
      { name: "GoogleNews-Hebrew", url: "https://news.google.com/rss/search?q=%D7%9E%D7%A0%D7%99%D7%95%D7%AA%20%D7%AA%D7%9C%20%D7%90%D7%91%D7%99%D7%91%20OR%20%D7%91%D7%95%D7%A8%D7%A1%D7%94&hl=he&gl=IL&ceid=IL:he" },
      { name: "Ynet-Finance", url: "https://www.ynet.co.il/Integration/StoryRss1854.xml" },
    ],
  },
} satisfies Mandate;

export interface UniverseEntry {
  symbol: string;
  name: string;
}

export const TASE_UNIVERSE: UniverseEntry[] = [
  { symbol: "LEUMI.TA", name: "בנק לאומי" },
  { symbol: "FIBI.TA", name: "הפועלים" },
  { symbol: "POLI.TA", name: "בנק דיסקונט" },
  { symbol: "NICE.TA", name: "נייס" },
  { symbol: "TEVA.TA", name: "טבע" },
  { symbol: "ICL.TA", name: "ICL" },
  { symbol: "ESLT.TA", name: "אלקטרוניקס" },
  { symbol: "BEZQ.TA", name: "בזק" },
  { symbol: "MZTF.TA", name: "מזטף" },
  { symbol: "DSEA.TA", name: "דירה להשקיעות" },
];

export const GLOBAL_UNIVERSE: UniverseEntry[] = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "נאסדק 100" },
  { symbol: "BTC-USD", name: "ביטקוין" },
];

export const UNIVERSE = { tase: TASE_UNIVERSE, global: GLOBAL_UNIVERSE };

export const ALL_SYMBOLS: string[] = [...MANDATE.universe.tase, ...MANDATE.universe.global];

export function symbolClass(symbol: string): "tase" | "global" | null {
  if (MANDATE.universe.tase.includes(symbol)) return "tase";
  if (MANDATE.universe.global.includes(symbol)) return "global";
  return null;
}

export function symbolName(symbol: string): string {
  const t = TASE_UNIVERSE.find((s) => s.symbol === symbol);
  if (t) return t.name;
  const g = GLOBAL_UNIVERSE.find((s) => s.symbol === symbol);
  return g ? g.name : symbol;
}

// the cabinet roster (from repos/saos-desk/src/agents.mjs)
export const AGENTS: { id: AgentId; name: string }[] = [
  { id: "technical", name: "הטכני" },
  { id: "valuation", name: "הערכת-השווי" },
  { id: "momentum", name: "המומנטום" },
  { id: "sentiment", name: "הסנטימנט" },
  { id: "risk", name: "הסיכונים" },
];

export const AGENT_NAMES: Record<string, string> = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));

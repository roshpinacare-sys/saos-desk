// saos-desk ingest — zero-trust ingestion core, TS port (R345)
// Faithful port of repos/saos-desk/src/ingest.mjs (source of truth).
// Pure functions only — client-safe: no clock, no randomness, no network, no fs.
// exec33 doctrine: every external byte is screened before it reaches the cabinet;
// drops are COUNTED, never silent; nothing is ever synthesized.

const INJECTION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "inj-ignore", re: /ignore\s+(all\s+)?(previous|prior|above)/i },
  { id: "inj-system", re: /system\s*(prompt|message|:)/i },
  { id: "inj-you-are", re: /you\s+are\s+now/i },
  { id: "inj-assistant", re: /assistant\s*:/i },
  { id: "inj-tool", re: /<\/?(tool_call|function_call|system)>/i },
  { id: "inj-script", re: /<script[\s>]/i },
  { id: "inj-js", re: /javascript\s*:/i },
  { id: "inj-handler", re: /\bon(error|load|click)\s*=/i },
  { id: "inj-eval", re: /\beval\s*\(/i },
  { id: "inj-template", re: /\$\{[^}]{0,200}\}/ },
];

export const round4 = (x: number) => Math.round(x * 10000) / 10000;

export interface ScreenResult {
  clean: string;
  flags: string[];
  dropped: boolean;
}

export function screenText(raw: string | null | undefined, maxLen = 4000): ScreenResult {
  if (typeof raw !== "string") return { clean: "", flags: ["type-not-string"], dropped: true };
  let s: string = raw;
  const flags: string[] = [];
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    flags.push("truncated-length");
  }
  let out = "";
  let ctrl = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 9) {
      out += ch;
      continue;
    }
    if (c === undefined || c < 32 || c === 127) {
      ctrl++;
      continue;
    }
    out += ch;
  }
  if (ctrl > 0) flags.push(`control-chars:${ctrl}`);
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(out)) flags.push(p.id);
  }
  const covertMatches = out.match(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g);
  const covert = covertMatches ? covertMatches.length : 0;
  if (covert > 0) {
    out = out.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "");
    flags.push(`covert-chars:${covert}`);
  }
  return { clean: out.trim(), flags, dropped: false };
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return null;
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1];
  return v;
}

export interface RssItem {
  title: string;
  link: string | null;
  date: string | null;
}

export interface RssStats {
  scanned: number;
  kept: number;
  droppedInjection: number;
  droppedMalformed: number;
  droppedOverflow: number;
  flags: string[];
}

export interface RssParsed {
  ok: boolean;
  reason?: string;
  items: RssItem[];
  stats: RssStats;
}

export function parseRss(
  xml: string | null | undefined,
  { maxItems = 12, maxTitleLen = 300, maxLinkLen = 500 } = {}
): RssParsed {
  const stats: RssStats = {
    scanned: 0,
    kept: 0,
    droppedInjection: 0,
    droppedMalformed: 0,
    droppedOverflow: 0,
    flags: [],
  };
  if (typeof xml !== "string" || xml.length === 0) {
    return { ok: false, reason: "empty-payload", items: [], stats };
  }
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) ?? [];
  const items: RssItem[] = [];
  for (const block of blocks) {
    stats.scanned++;
    if (items.length >= maxItems) {
      stats.droppedOverflow++;
      continue;
    }
    const rawTitle = tag(block, "title");
    const rawLink = tag(block, "link") ?? tag(block, "guid");
    const rawDate = tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published");
    if (!rawTitle) {
      stats.droppedMalformed++;
      continue;
    }
    const t = screenText(rawTitle, maxTitleLen);
    if (t.dropped) {
      stats.droppedMalformed++;
      continue;
    }
    if (t.flags.some((f) => f.startsWith("inj-"))) {
      stats.droppedInjection++;
      stats.flags.push(...t.flags.filter((f) => f.startsWith("inj-")));
      continue;
    }
    let link: string | null = null;
    if (rawLink) {
      const l = screenText(rawLink, maxLinkLen);
      if (!l.dropped && /^https?:\/\/[^\s"'<>]+$/.test(l.clean)) link = l.clean;
    }
    let date: string | null = null;
    if (rawDate) {
      const d = screenText(rawDate, 64);
      if (!d.dropped && !Number.isNaN(Date.parse(d.clean))) date = d.clean;
    }
    items.push({ title: t.clean, link, date });
    stats.kept++;
  }
  if (items.length === 0 && stats.scanned === 0) {
    return { ok: false, reason: "no-items-found", items: [], stats };
  }
  return { ok: true, items, stats };
}

export interface ChartParsed {
  ok: boolean;
  reason?: string;
  symbol?: string | null;
  currency?: string | null;
  exchange?: string | null;
  last?: number;
  prevClose?: number;
  changePct?: number;
  bars?: { t: number; c: number; h: number; l: number }[];
  skippedBars?: number;
}

export function parseChart(json: unknown): ChartParsed {
  let d: { chart?: { result?: unknown[]; error?: { code?: string } | null } } | null = null;
  try {
    d = typeof json === "string" ? (JSON.parse(json) as typeof d) : (json as typeof d);
  } catch {
    return { ok: false, reason: "json-unparseable" };
  }
  const res = d?.chart?.result;
  if (!Array.isArray(res) || res.length === 0) {
    const code = d?.chart?.error?.code ?? "no-result";
    return { ok: false, reason: `chart-error:${code}` };
  }
  const r = res[0] as {
    meta?: { symbol?: string; currency?: string; exchangeName?: string };
    timestamp?: number[];
    indicators?: { quote?: { close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[] }[] };
  };
  const meta = r?.meta ?? {};
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q || !Array.isArray(q.close) || ts.length < 2) {
    return { ok: false, reason: "insufficient-series" };
  }
  if (ts.length !== q.close.length) return { ok: false, reason: "series-length-mismatch" };
  const bars: { t: number; c: number; h: number; l: number }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const c = q.close[i];
    if (typeof t !== "number" || !Number.isFinite(t) || typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
    const hv = q.high?.[i];
    const lv = q.low?.[i];
    const h = typeof hv === "number" && Number.isFinite(hv) ? hv : c;
    const l = typeof lv === "number" && Number.isFinite(lv) ? lv : c;
    if (h < l) return { ok: false, reason: "bar-high-below-low" };
    if (bars.length > 0 && t <= bars[bars.length - 1].t) return { ok: false, reason: "timestamps-not-increasing" };
    bars.push({ t, c: round4(c), h: round4(h), l: round4(l) });
  }
  if (bars.length < 2) return { ok: false, reason: "usable-bars-below-2" };
  const last = bars[bars.length - 1].c;
  const prevClose = bars[bars.length - 2].c;
  return {
    ok: true,
    symbol: meta.symbol ?? null,
    currency: meta.currency ?? null,
    exchange: meta.exchangeName ?? null,
    last: round4(last),
    prevClose: round4(prevClose),
    changePct: round4(((last - prevClose) / prevClose) * 100),
    bars,
    skippedBars: ts.length - bars.length,
  };
}

export interface SymbolVerdict {
  symbol: string;
  verdict: "ALIVE" | "DEAD" | "ANOMALY";
  last?: number;
  changePct?: number;
  reason?: string;
}

export interface NewsVerdict {
  feed: string;
  verdict: "ALIVE" | "EMPTY" | "DEAD";
  items: number;
  reason?: string | null;
  droppedInjection: number;
}

export interface ProbeInput {
  quotes: { symbol: string; ok: boolean; last?: number; prevClose?: number; changePct?: number; bars?: { t: number; c: number; h: number; l: number }[]; reason?: string }[];
  news: { feed: string; ok: boolean; items?: unknown[]; stats?: { droppedInjection?: number }; reason?: string }[];
  probedAtMin?: number | null;
}

export interface AssessOptions {
  minAliveRatio?: number;
  anomalyMovePct?: number;
  maxAgeMin?: number;
  freshnessMin?: number;
}

export interface FeedAssessment {
  verdict: "ALIVE" | "REFRAIN";
  ratio: number;
  alive: number;
  dead: number;
  anomalies: number;
  symbols: SymbolVerdict[];
  news: NewsVerdict[];
  reasons: string[];
}

// feed assessment + kill-switch (pure) — freshness is PASSED IN, never clock-read
export function assessFeeds(probes: ProbeInput, opts: AssessOptions = {}): FeedAssessment {
  const minAliveRatio = opts.minAliveRatio ?? 0.7;
  const anomalyMovePct = opts.anomalyMovePct ?? 12;
  const maxAgeMin = opts.maxAgeMin ?? 90;
  const freshnessMin = opts.freshnessMin ?? 0;
  const symbols: SymbolVerdict[] = (probes.quotes ?? []).map((p) => {
    if (!p.ok) return { symbol: p.symbol, verdict: "DEAD", reason: p.reason ?? "fetch-failed" };
    const mv = Math.abs(p.changePct ?? 0);
    if (mv > anomalyMovePct) {
      return { symbol: p.symbol, verdict: "ANOMALY", reason: `move-${p.changePct}%>±${anomalyMovePct}% — חשד-זיוף/חריגה` };
    }
    const bars = p.bars ?? [];
    for (let i = bars.length - 1; i > 0 && i > bars.length - 6; i--) {
      const prevC = bars[i - 1].c;
      const jump = Math.abs((bars[i].c - prevC) / prevC) * 100;
      if (jump > anomalyMovePct * 4) {
        return { symbol: p.symbol, verdict: "ANOMALY", reason: `bar-jump-${round4(jump)}% — סדרה-חשודה` };
      }
    }
    return { symbol: p.symbol, verdict: "ALIVE", last: p.last, changePct: p.changePct };
  });
  const news: NewsVerdict[] = (probes.news ?? []).map((n) => ({
    feed: n.feed,
    verdict: n.ok ? ((n.items?.length ?? 0) > 0 ? "ALIVE" : "EMPTY") : "DEAD",
    items: n.ok ? (n.items?.length ?? 0) : 0,
    reason: n.ok ? null : (n.reason ?? "fetch-failed"),
    droppedInjection: n.stats?.droppedInjection ?? 0,
  }));
  const alive = symbols.filter((s) => s.verdict === "ALIVE");
  const dead = symbols.filter((s) => s.verdict === "DEAD");
  const anomalies = symbols.filter((s) => s.verdict === "ANOMALY");
  const ratio = symbols.length ? alive.length / symbols.length : 0;
  const reasons: string[] = [];
  let verdict: "ALIVE" | "REFRAIN" = "ALIVE";
  if (anomalies.length > 0) {
    verdict = "REFRAIN";
    reasons.push(`חריגה-מבנית ב-${anomalies.length} סמלים (${anomalies.map((a) => a.symbol).join(", ")}) — חשד-זיוף-נתונים: REFRAIN עד אישור-בעלים חתום`);
  }
  if (ratio < minAliveRatio) {
    verdict = "REFRAIN";
    reasons.push(`חיים ${alive.length}/${symbols.length} (יחס ${round4(ratio * 100)}% < רצפת-מנדט ${round4(minAliveRatio * 100)}%) — REFRAIN`);
  }
  if (freshnessMin > maxAgeMin) {
    verdict = "REFRAIN";
    reasons.push(`נתונים מזדקנים (${freshnessMin}דק > ${maxAgeMin}דק) — REFRAIN`);
  }
  if (reasons.length === 0) {
    reasons.push(`עורק-חי: ${alive.length}/${symbols.length} סמלים חיים, ${news.filter((n) => n.verdict === "ALIVE").length}/${news.length} פידי-חדשות חיים`);
  }
  return { verdict, ratio: round4(ratio), alive: alive.length, dead: dead.length, anomalies: anomalies.length, symbols, news, reasons };
}

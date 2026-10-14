// saos-desk ingest — zero-trust ingestion core (R345)
// LAWS: pure functions only — no clock, no unseeded randomness, no network, no fs here.
// exec33 doctrine: (1) no live credentials anywhere; (2) every external byte is screened
// before it reaches the cabinet; drops are COUNTED, never silent; nothing is synthesized.
// A dead or anomalous feed produces REFRAIN — never a fabricated number.

import { round4, sig8 } from "./kernel.mjs";

// ---- zero-trust text screening (exec33 #2: input screening) ------------------
const INJECTION_PATTERNS = [
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

// maxLen caps are mandate-of-the-call (default 4000 chars) — length itself is a vector.
export function screenText(raw, maxLen = 4000) {
  if (typeof raw !== "string") return { clean: "", flags: ["type-not-string"], dropped: true };
  let flags = [];
  if (raw.length > maxLen) { raw = raw.slice(0, maxLen); flags.push("truncated-length"); }
  // strip control characters (keep \n \t) — control bytes are a carrier, not content
  let out = "";
  let ctrl = 0;
  for (const ch of raw) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 9) { out += ch; continue; }
    if (c < 32 || c === 127) { ctrl++; continue; }
    out += ch;
  }
  if (ctrl > 0) flags.push(`control-chars:${ctrl}`);
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(out)) flags.push(p.id);
  }
  // zero-width / bidi override chars = covert-carrier vectors
  const covert = (out.match(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g) || []).length;
  if (covert > 0) { out = out.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ""); flags.push(`covert-chars:${covert}`); }
  return { clean: out.trim(), flags, dropped: false };
}

// ---- RSS parse (pure) — minimal, tolerant, screened ---------------------------
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return null;
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) v = cdata[1];
  return v;
}

export function parseRss(xml, { maxItems = 12, maxTitleLen = 300, maxLinkLen = 500 } = {}) {
  const stats = { scanned: 0, kept: 0, droppedInjection: 0, droppedMalformed: 0, droppedOverflow: 0, flags: [] };
  if (typeof xml !== "string" || xml.length === 0) return { ok: false, reason: "empty-payload", items: [], stats };
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) || [];
  const items = [];
  for (const block of blocks) {
    stats.scanned++;
    if (items.length >= maxItems) { stats.droppedOverflow++; continue; }
    const rawTitle = tag(block, "title");
    const rawLink = tag(block, "link") ?? tag(block, "guid");
    const rawDate = tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published");
    if (!rawTitle) { stats.droppedMalformed++; continue; }
    const t = screenText(rawTitle, maxTitleLen);
    if (t.dropped) { stats.droppedMalformed++; continue; }
    if (t.flags.some((f) => f.startsWith("inj-"))) { stats.droppedInjection++; stats.flags.push(...t.flags.filter((f) => f.startsWith("inj-"))); continue; }
    let link = null;
    if (rawLink) {
      const l = screenText(rawLink, maxLinkLen);
      // a link is only kept if it is a plain http(s) URL after screening
      if (!l.dropped && /^https?:\/\/[^\s"'<>]+$/.test(l.clean)) link = l.clean;
    }
    let date = null;
    if (rawDate) {
      const d = screenText(rawDate, 64);
      if (!d.dropped && !Number.isNaN(Date.parse(d.clean))) date = d.clean;
    }
    items.push({ title: t.clean, link, date });
    stats.kept++;
  }
  if (items.length === 0 && stats.scanned === 0) return { ok: false, reason: "no-items-found", items: [], stats };
  return { ok: true, items, stats };
}

// ---- Yahoo v8 chart parse (pure, fail-closed) --------------------------------
export function parseChart(json) {
  let d = null;
  try { d = typeof json === "string" ? JSON.parse(json) : json; } catch { return { ok: false, reason: "json-unparseable" }; }
  const res = d?.chart?.result;
  if (!Array.isArray(res) || res.length === 0) {
    const code = d?.chart?.error?.code ?? "no-result";
    return { ok: false, reason: `chart-error:${code}` };
  }
  const r = res[0];
  const meta = r?.meta ?? {};
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q || !Array.isArray(q.close) || ts.length < 2) return { ok: false, reason: "insufficient-series" };
  if (ts.length !== q.close.length) return { ok: false, reason: "series-length-mismatch" };
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i], c = q.close[i];
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue; // honest skip of null bars (halts), counted below
    const h = Number.isFinite(q.high?.[i]) ? q.high[i] : c;
    const l = Number.isFinite(q.low?.[i]) ? q.low[i] : c;
    const o = Number.isFinite(q.open?.[i]) && q.open[i] > 0 ? q.open[i] : c;
    if (h < l) return { ok: false, reason: "bar-high-below-low" }; // structural forgery, fail-closed
    if (bars.length > 0 && t <= bars[bars.length - 1].t) return { ok: false, reason: "timestamps-not-increasing" };
    bars.push({ t, o: round4(o), c: round4(c), h: round4(h), l: round4(l) });
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

// ---- feed assessment + kill-switch (pure) -------------------------------------
// doctrine (Owner, exec33): feed drop or ATR forgery => hard REFRAIN, activity stops
// until manual signed approval. Per-symbol verdicts + desk-wide verdict.
// freshnessMin/maxAgeMin are PASSED IN — this module never reads a clock.
export function assessFeeds(probes, { minAliveRatio = 0.7, anomalyMovePct = 12, maxAgeMin = 90, freshnessMin = 0 } = {}) {
  const symbols = (probes.quotes ?? []).map((p) => {
    if (!p.ok) return { symbol: p.symbol, verdict: "DEAD", reason: p.reason ?? "fetch-failed" };
    const mv = Math.abs(p.changePct ?? 0);
    if (mv > anomalyMovePct) return { symbol: p.symbol, verdict: "ANOMALY", reason: `move-${p.changePct}%>±${anomalyMovePct}% — חשד-זיוף/חריגה` };
    // structural check: close-to-close jump beyond 4× anomaly threshold = suspect series
    const bars = p.bars ?? [];
    for (let i = bars.length - 1; i > 0 && i > bars.length - 6; i--) {
      const jump = Math.abs((bars[i].c - bars[i - 1].c) / bars[i - 1].c) * 100;
      if (jump > anomalyMovePct * 4) return { symbol: p.symbol, verdict: "ANOMALY", reason: `bar-jump-${round4(jump)}% — סדרה-חשודה` };
    }
    return { symbol: p.symbol, verdict: "ALIVE", last: p.last, changePct: p.changePct };
  });
  const news = (probes.news ?? []).map((n) => ({
    feed: n.feed,
    verdict: n.ok ? (n.items?.length ? "ALIVE" : "EMPTY") : "DEAD",
    items: n.ok ? (n.items?.length ?? 0) : 0,
    reason: n.ok ? null : (n.reason ?? "fetch-failed"),
    droppedInjection: n.stats?.droppedInjection ?? 0,
  }));
  const alive = symbols.filter((s) => s.verdict === "ALIVE");
  const dead = symbols.filter((s) => s.verdict === "DEAD");
  const anomalies = symbols.filter((s) => s.verdict === "ANOMALY");
  const ratio = symbols.length ? alive.length / symbols.length : 0;
  const reasons = [];
  let verdict = "ALIVE";
  if (anomalies.length > 0) { verdict = "REFRAIN"; reasons.push(`חריגה-מבנית ב-${anomalies.length} סמלים (${anomalies.map((a) => a.symbol).join(", ")}) — חשד-זיוף-נתונים: REFRAIN עד אישור-בעלים חתום`); }
  if (ratio < minAliveRatio) { verdict = "REFRAIN"; reasons.push(`חיים ${alive.length}/${symbols.length} (יחס ${round4(ratio * 100)}% < רצפת-מנדט ${round4(minAliveRatio * 100)}%) — REFRAIN`); }
  if (freshnessMin > maxAgeMin) { verdict = "REFRAIN"; reasons.push(`נתונים מזדקנים (${freshnessMin}דק > ${maxAgeMin}דק) — REFRAIN`); }
  if (reasons.length === 0) reasons.push(`עורק-חי: ${alive.length}/${symbols.length} סמלים חיים, ${news.filter((n) => n.verdict === "ALIVE").length}/${news.length} פידי-חדשות חיים`);
  return { verdict, ratio: round4(ratio), alive: alive.length, dead: dead.length, anomalies: anomalies.length, symbols, news, reasons };
}

// ---- guarded chair (the guardedRound law) --------------------------------------
// A REFRAIN verdict can never produce an order-eligible decision. Fail-closed.
export function guardedChair(board, feedAssessment) {
  if (!feedAssessment || feedAssessment.verdict !== "REFRAIN") return { ...board, refrain: false };
  const ch = board.chair ?? {};
  return {
    ...board,
    refrain: true,
    chair: {
      ...ch,
      decision: "flat",
      sizePct: 0,
      refrain: true,
      notes: [...(ch.notes ?? []), `שער-עורק-הנתונים (exec33): ${feedAssessment.reasons.join(" · ")} — הכרעה נצפית בלבד, אפס פוזיציה`],
    },
  };
}

// ---- sealed feed-state signature ------------------------------------------------
export function feedSig(payloadWithoutSig) { return sig8(payloadWithoutSig); }

'use client'

// חדר-הישיבות הריבוני — R344 · Sovereign Trading Boardroom console
// Hebrew RTL, dark terminal aesthetic. Real deterministic engine behind real APIs.
// Honest rails: paper-only, zero keys, all market data here is labelled simulation.

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  BookOpen,
  Briefcase,
  CheckCircle2,
  Dna,
  FlaskConical,
  Gavel,
  History,
  KeyRound,
  Landmark,
  LineChart,
  Loader2,
  MessageSquare,
  Newspaper,
  Radio,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { GLOBAL_UNIVERSE, TASE_UNIVERSE, symbolName } from '@/lib/desk/mandate'
import type {
  BacktestResponse,
  ChairResult,
  DebateRound,
  Decision,
  DeskArtifact,
  FeedsResponse,
  Outcome,
  PositionsResponse,
  LedgerResponse,
  LedgerEntryRow,
  RiskGateResult,
  Verdict,
  WeightDelta,
} from '@/lib/desk/types'

// ---- Hebrew labels -----------------------------------------------------------
const REGIME_HE: Record<string, string> = {
  'trend-up': 'מגמה עולה',
  'trend-down': 'מגמה יורדת',
  'choppy-highvol': 'תנודתי גבוה',
  'choppy-lowvol': 'תנודתי נמוך',
}

const DECISION_HE: Record<string, string> = {
  buy: 'קנייה',
  sell: 'מכירה',
  flat: 'שטוח',
  hold: 'החזקה',
}

const AGENT_NAMES_HE: Record<string, string> = {
  technical: 'הטכני',
  valuation: 'הערכת-השווי',
  momentum: 'המומנטום',
  sentiment: 'הסנטימנט',
  risk: 'הסיכונים',
}

// ---- shared view model -------------------------------------------------------
interface MarketBasic {
  price: number
  atr14: number
  rsi14: number
  sma20: number
  sma50: number
  trendScore: number
  volPct: number
  source: string
}

interface BeatView {
  beat: number
  seed: number
  symbol: string
  regime: string
  sig: string | null
  agents: Verdict[] | null
  debate: DebateRound[] | null
  chair: ChairResult | null
  riskGate: RiskGateResult | null
  outcome: Outcome | null
  weightsAfter: WeightDelta[] | null
  market: MarketBasic | null
  closes: number[] | null
}

interface StatusResponse {
  execution: string
  liveOwnerArmed: boolean
  universe: { tase: string[]; global: string[] }
  feeds: string[]
  limits: {
    maxPositionPct: number
    maxDailyLossPct: number
    kellyCap: number
    drawdownHaltPct: number
    volHaltPct: number
  }
  weights: Record<string, { weight: number; wins: number; losses: number }>
  beatCount: number
  chainHead: string | null
  equity: number[]
}

interface HistoryItem {
  id: number
  beat: number
  seed: number
  symbol: string
  regime: string
  decision: string
  sizePct: number
  confidence: number
  quorumPassed: boolean
  riskPassed: boolean
  realizedPct: number
  sig: string
  createdAt: string
  agents: Verdict[] | null
  debate: DebateRound[] | null
  chair: ChairResult | null
  riskGate: RiskGateResult | null
  outcome: Outcome | null
  weightsAfter: WeightDelta[] | null
  marketBasic: MarketBasic | null
  closes: number[] | null
  artifactError: string | null
}

function historyToView(item: HistoryItem): BeatView {
  return {
    beat: item.beat,
    seed: item.seed,
    symbol: item.symbol,
    regime: item.regime,
    sig: item.sig,
    agents: item.agents,
    debate: item.debate,
    chair: item.chair,
    riskGate: item.riskGate,
    outcome: item.outcome,
    weightsAfter: item.weightsAfter,
    market: item.marketBasic,
    closes: item.closes,
  }
}

function artifactToView(art: DeskArtifact): BeatView {
  return {
    beat: art.beat,
    seed: art.seed,
    symbol: art.symbol,
    regime: art.regime,
    sig: art.sig ?? null,
    agents: art.agents,
    debate: art.debate,
    chair: art.chair,
    riskGate: art.riskGate,
    outcome: art.outcome,
    weightsAfter: art.weightsAfter,
    market: {
      price: art.market.price,
      atr14: art.market.atr14,
      rsi14: art.market.rsi14,
      sma20: art.market.sma20,
      sma50: art.market.sma50,
      trendScore: art.market.trendScore,
      volPct: art.market.volPct,
      source: art.market.source,
    },
    closes: art.market.bars.map((b) => b[3]),
  }
}

// ---- small helpers -----------------------------------------------------------
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

function pctStr(x: number): string {
  return `${x > 0 ? '+' : ''}${x}%`
}

function pnlClass(x: number): string {
  if (x > 0) return 'text-emerald-400'
  if (x < 0) return 'text-rose-400'
  return 'text-neutral-400'
}

function Num({ v, className }: { v: string | number | null | undefined; className?: string }) {
  return (
    <span dir="ltr" className={`font-mono ${className ?? ''}`}>
      {v ?? '—'}
    </span>
  )
}

function ActionBadge({ action }: { action: string }) {
  const cls =
    action === 'buy'
      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
      : action === 'sell'
        ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
        : 'border-neutral-600/50 bg-neutral-500/10 text-neutral-300'
  return (
    <Badge variant="outline" className={`${cls} shrink-0`}>
      {DECISION_HE[action] ?? action}
    </Badge>
  )
}

function ConfidenceBar({ value, action }: { value: number; action: string }) {
  const color =
    action === 'buy' ? 'bg-emerald-500' : action === 'sell' ? 'bg-rose-500' : 'bg-neutral-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
        />
      </div>
      <Num v={value.toFixed(2)} className="text-[11px] text-neutral-400" />
    </div>
  )
}

function Sparkline({ closes, stroke, label }: { closes: number[] | null; stroke: string; label: string }) {
  if (!closes || closes.length < 2) {
    return <p className="text-xs text-neutral-500">אין נתונים לשרטוט</p>
  }
  const W = 600
  const H = 100
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const range = max - min || 1
  const points = closes
    .map((c, i) => `${((i / (closes.length - 1)) * W).toFixed(2)},${(H - ((c - min) / range) * H).toFixed(2)}`)
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-20 w-full"
      role="img"
      aria-label={label}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function EquityCurve({ equity }: { equity: number[] }) {
  const cum: number[] = []
  let s = 0
  for (const r of equity) {
    s += r
    cum.push(s)
  }
  const W = 600
  const H = 120
  const min = Math.min(0, ...cum)
  const max = Math.max(0, ...cum)
  const range = max - min || 1
  const yOf = (v: number) => H - ((v - min) / range) * H
  const points = cum
    .map((c, i) => `${((i / Math.max(1, cum.length - 1)) * W).toFixed(2)},${yOf(c).toFixed(2)}`)
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-28 w-full"
      role="img"
      aria-label="עקומת-הון מצטברת"
    >
      <line
        x1="0"
        y1={yOf(0).toFixed(2)}
        x2={W}
        y2={yOf(0).toFixed(2)}
        stroke="#525252"
        strokeDasharray="4 4"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={points}
        fill="none"
        stroke="#10b981"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function WeightEvolutionBar({ before, after }: { before: number; after: number }) {
  const pos = (w: number) => Math.min(100, Math.max(0, ((w - 0.5) / 1.5) * 100))
  const changed = after > before
  const color = changed ? 'bg-emerald-500' : after < before ? 'bg-rose-500' : 'bg-neutral-500'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pos(after)}%` }} />
    </div>
  )
}

function Panel({
  title,
  icon,
  tag,
  children,
  className,
}: {
  title: string
  icon?: React.ReactNode
  tag?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={`border-neutral-800 bg-neutral-900 ${className ?? ''}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base text-neutral-100">
          {icon}
          <span>{title}</span>
          {tag}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  )
}

function SimTag() {
  return (
    <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] leading-none text-neutral-400">
      סימולציה
    </span>
  )
}

// ---- the console -------------------------------------------------------------
export default function DeskPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [ledger, setLedger] = useState<HistoryItem[]>([])
  const [view, setView] = useState<BeatView | null>(null)
  const [symbol, setSymbol] = useState('LEUMI.TA')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [briefing, setBriefing] = useState<{ loading: boolean; ok: boolean; text: string | null }>({
    loading: false,
    ok: true,
    text: null,
  })
  const [feeds, setFeeds] = useState<FeedsResponse | null>(null)
  const [feedsLoading, setFeedsLoading] = useState(true)
  const [feedsError, setFeedsError] = useState<string | null>(null)
  const [positions, setPositions] = useState<PositionsResponse | null>(null)
  const [positionsLoading, setPositionsLoading] = useState(true)
  const [positionsBusy, setPositionsBusy] = useState(false)
  const [positionsError, setPositionsError] = useState<string | null>(null)
  const [positionsMsg, setPositionsMsg] = useState<string | null>(null)
  const [bt, setBt] = useState<BacktestResponse | null>(null)
  const [btLoading, setBtLoading] = useState(false)
  const [btError, setBtError] = useState<string | null>(null)
  const [btRange, setBtRange] = useState<'3mo' | '6mo' | '1y'>('6mo')
  const [sovereignBook, setSovereignBook] = useState<LedgerResponse | null>(null)
  const [bookLoading, setBookLoading] = useState(true)

  const loadFeeds = useCallback(async () => {
    setFeedsLoading(true)
    setFeedsError(null)
    try {
      const j = await getJson<FeedsResponse>('/api/desk/feeds')
      setFeeds(j)
    } catch {
      setFeedsError('עורק-הנתונים אינו זמין כרגע — fail-closed, שום נתון לא מומצא.')
    } finally {
      setFeedsLoading(false)
    }
  }, [])

  const loadPositions = useCallback(async () => {
    setPositionsLoading(true)
    try {
      const j = await getJson<PositionsResponse>('/api/desk/positions')
      setPositions(j)
      setPositionsError(null)
    } catch {
      setPositionsError('ספר-העמדות אינו זמין כרגע — fail-closed.')
    } finally {
      setPositionsLoading(false)
    }
  }, [])

  const loadSovereignBook = useCallback(async () => {
    setBookLoading(true)
    try {
      const j = await getJson<LedgerResponse>('/api/desk/ledger')
      setSovereignBook(j)
    } catch {
      setSovereignBook(null) // fail-closed: אין ספר מזויף
    } finally {
      setBookLoading(false)
    }
  }, [])

  async function deskAction(body: Record<string, unknown>) {
    setPositionsBusy(true)
    setPositionsMsg(null)
    try {
      const res = await fetch('/api/desk/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = (await res.json()) as { ok: boolean; message?: string }
      if (!res.ok || !j.ok) {
        setPositionsMsg(j.message ?? `הפעולה נכשלה (HTTP ${res.status}).`)
      } else {
        setPositionsMsg(body.action === 'open' ? 'עמדת-נייר נפתחה במחיר-חי.' : 'העמדה נסגרה במחיר-חי.')
        await loadPositions()
        await loadSovereignBook()
      }
    } catch {
      setPositionsMsg('הפעולה נכשלה — השירות אינו זמין כרגע.')
    } finally {
      setPositionsBusy(false)
    }
  }

  async function runBacktest() {
    setBtLoading(true)
    setBtError(null)
    try {
      const j = await getJson<BacktestResponse>(`/api/desk/backtest?symbol=${encodeURIComponent(symbol)}&range=${btRange}`)
      setBt(j)
      if (!j.ok) setBtError(j.message ?? 'המנוע סירב — כנה.')
    } catch {
      setBtError('מפעל-הבקטסט אינו זמין כרגע — fail-closed.')
    } finally {
      setBtLoading(false)
    }
  }

  const refresh = useCallback(async () => {
    const [st, hist] = await Promise.all([
      getJson<StatusResponse>('/api/desk/status'),
      getJson<{ ok: boolean; items: HistoryItem[] }>('/api/desk/history?limit=10'),
    ])
    setStatus(st)
    setLedger(hist.items)
    return hist.items
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const items = await refresh()
        if (!alive) return
        if (items.length > 0 && items[0]) setView(historyToView(items[0]))
      } catch {
        if (alive) setLoadError('טעינת מצב-השולחן נכשלה — בדוק שהשירות זמין ורענן את העמוד.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    loadFeeds()
    loadPositions()
    loadSovereignBook()
    return () => {
      alive = false
    }
  }, [refresh, loadFeeds, loadPositions, loadSovereignBook])

  async function runSession() {
    setRunning(true)
    setSessionError(null)
    try {
      const res = await fetch('/api/desk/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })
      const j = (await res.json()) as
        | { ok: true; artifact: DeskArtifact }
        | { ok: false; message?: string }
      if (!res.ok || !j.ok) {
        setSessionError(
          (j as { message?: string }).message ?? `הרצת המושב נכשלה (HTTP ${res.status}).`
        )
      } else {
        setView(artifactToView(j.artifact))
        try {
          await refresh()
        } catch {
          /* the beat itself succeeded — keep the artifact on screen honestly */
        }
      }
    } catch {
      setSessionError('הרצת המושב נכשלה — השירות אינו זמין כרגע.')
    } finally {
      setRunning(false)
    }
  }

  async function runBriefing() {
    const last = ledger[0]
    if (!last) return
    setBriefing({ loading: true, ok: true, text: null })
    try {
      const res = await fetch('/api/desk/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beatId: last.id }),
      })
      const j = (await res.json()) as { ok: boolean; briefing?: string; message?: string }
      if (res.ok && j.ok && j.briefing) {
        setBriefing({ loading: false, ok: true, text: j.briefing })
      } else {
        setBriefing({ loading: false, ok: false, text: j.message ?? null })
      }
    } catch {
      setBriefing({ loading: false, ok: false, text: null })
    }
  }

  const chair = view?.chair ?? null
  const artifactBroken = view !== null && chair === null

  return (
    <div dir="rtl" lang="he" className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6">

        {/* ---- a. Header ---- */}
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-xl font-bold sm:text-2xl">
              חדר-הישיבות הריבוני <Num v="R344" className="text-emerald-400" />
            </h1>
            {loading ? (
              <Skeleton className="h-5 w-40 bg-neutral-800" />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {status?.execution === 'paper' && (
                  <Badge variant="outline" className="border-emerald-500/50 bg-emerald-500/10 text-emerald-400">
                    נייר (PAPER)
                  </Badge>
                )}
                {status && !status.liveOwnerArmed && (
                  <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-400">
                    <KeyRound className="ml-1 h-3 w-3" />
                    אפס מפתחות · ביצוע-חי נעול (דו-מפתחות)
                  </Badge>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
            {loading ? (
              <Skeleton className="h-4 w-56 bg-neutral-800" />
            ) : (
              <>
                <span>
                  מושב <Num v={`#${status?.beatCount ?? 0}`} />
                </span>
                <span>
                  ראש-השרשרת: <Num v={status?.chainHead ? `sig:${status.chainHead}` : '—'} className="text-neutral-400" />
                </span>
                <span>
                  ערוצי-עברית: {status?.feeds?.join(' · ') ?? '—'}
                </span>
              </>
            )}
          </div>
          {loadError && (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {loadError}
            </p>
          )}
        </header>

        {/* ---- b. Control strip ---- */}
        <Card className="border-neutral-800 bg-neutral-900">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <label className="sr-only" htmlFor="symbol-select">בחירת סימל</label>
            <Select value={symbol} onValueChange={setSymbol} disabled={running}>
              <SelectTrigger
                id="symbol-select"
                className="w-full border-neutral-800 bg-neutral-950 text-neutral-100 sm:w-72"
                aria-label="בחירת סימל מהאוניברס"
              >
                <SelectValue placeholder="בחר סימל" />
              </SelectTrigger>
              <SelectContent className="border-neutral-800 bg-neutral-900 text-neutral-100">
                <SelectGroup>
                  <SelectLabel className="text-neutral-500">בורסת תל אביב</SelectLabel>
                  {TASE_UNIVERSE.map((s) => (
                    <SelectItem key={s.symbol} value={s.symbol}>
                      {s.name} · <Num v={s.symbol} className="text-xs text-neutral-400" />
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel className="text-neutral-500">גלובלי</SelectLabel>
                  {GLOBAL_UNIVERSE.map((s) => (
                    <SelectItem key={s.symbol} value={s.symbol}>
                      {s.name} · <Num v={s.symbol} className="text-xs text-neutral-400" />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              onClick={runSession}
              disabled={running || loading}
              className="bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {running ? (
                <>
                  <Loader2 className="ml-2 h-4 w-4 animate-spin" aria-hidden />
                  המושב מתנהל…
                </>
              ) : (
                <>
                  <Gavel className="ml-2 h-4 w-4" aria-hidden />
                  כנס מושב
                </>
              )}
            </Button>
            {sessionError && (
              <p role="alert" className="flex-1 text-sm text-rose-300">
                {sessionError}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ---- b2. Live data artery (R345) — exec33 zero-trust, keyless, fail-closed ---- */}
        <section aria-label="עורק-הנתונים החי" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-400">
            <Radio className="h-4 w-4 text-emerald-500" aria-hidden />
            <span>
              עורק-הנתונים החי <Num v="R345" className="text-emerald-400" />
            </span>
            <span className="text-neutral-600">· exec33: אפס מפתחות · סינון אפס-אמון · fail-closed</span>
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={loadFeeds}
              disabled={feedsLoading}
              className="border-neutral-800 bg-neutral-950 text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
            >
              {feedsLoading ? (
                <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="ml-1 h-3.5 w-3.5" aria-hidden />
              )}
              רענן עורק
            </Button>
          </div>

          {feedsLoading && !feeds ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Skeleton className="h-80 bg-neutral-900" />
              <Skeleton className="h-80 bg-neutral-900" />
            </div>
          ) : feedsError ? (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {feedsError}
            </p>
          ) : feeds ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* quotes — real measured prices, honest per-symbol verdicts */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge
                      variant="outline"
                      className={
                        feeds.verdict === 'ALIVE'
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                          : 'border-rose-500/50 bg-rose-500/10 text-rose-400'
                      }
                    >
                      {feeds.verdict === 'ALIVE' ? 'עורק חי (ALIVE)' : 'REFRAIN — נצפית בלבד'}
                    </Badge>
                    <span className="text-xs font-normal text-neutral-500">
                      נמדד{' '}
                      <Num
                        v={new Intl.DateTimeFormat('he-IL', {
                          timeZone: 'Asia/Jerusalem',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(new Date(feeds.probedAt))}
                      />{' '}
                      · חיים <Num v={`${feeds.alive}/${feeds.alive + feeds.dead + feeds.anomalies}`} />
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="mb-3 list-disc space-y-0.5 pr-4 text-[11px] text-neutral-500">
                    {feeds.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  <div className="desk-scroll max-h-72 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-neutral-800">
                          <TableHead className="text-neutral-400">סמל</TableHead>
                          <TableHead className="text-neutral-400">שם</TableHead>
                          <TableHead className="text-left text-neutral-400">עמדה אחרונה</TableHead>
                          <TableHead className="text-left text-neutral-400">שינוי יומי</TableHead>
                          <TableHead className="text-neutral-400">מצב</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {feeds.symbols.map((s) => (
                          <TableRow key={s.symbol} className="border-neutral-800/60">
                            <TableCell className="font-mono text-xs text-neutral-200">{s.symbol}</TableCell>
                            <TableCell className="text-xs text-neutral-400">{symbolName(s.symbol)}</TableCell>
                            <TableCell className="text-left font-mono text-xs text-neutral-200">
                              {s.verdict === 'ALIVE' && typeof s.last === 'number' ? s.last.toLocaleString('en-US') : '—'}
                            </TableCell>
                            <TableCell
                              className={`text-left font-mono text-xs ${
                                typeof s.changePct === 'number' ? pnlClass(s.changePct) : 'text-neutral-500'
                              }`}
                            >
                              {typeof s.changePct === 'number' ? pctStr(s.changePct) : '—'}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`px-1.5 py-0 text-[10px] ${
                                  s.verdict === 'ALIVE'
                                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                    : s.verdict === 'ANOMALY'
                                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                                      : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                                }`}
                              >
                                {s.verdict === 'ALIVE' ? 'חי' : s.verdict === 'ANOMALY' ? 'חריג' : 'מת'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              {/* screened Hebrew headlines + screening evidence */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    <Newspaper className="h-4 w-4 text-amber-500" aria-hidden />
                    מסכי-החדשות העבריים — לאחר סינון אפס-אמון
                    <span className="text-xs font-normal text-neutral-500">
                      הזרקות-שנפלו <Num v={feeds.screening.injectionDrops} /> · פריטים-פגומים <Num v={feeds.screening.malformedDrops} />
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="desk-scroll max-h-80 space-y-4 overflow-y-auto pl-1">
                    {feeds.headlines.map((h) => (
                      <div key={h.feed}>
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-xs font-semibold text-neutral-300">{h.feed}</span>
                          <Badge
                            variant="outline"
                            className={`px-1.5 py-0 text-[10px] ${
                              h.ok
                                ? h.items.length > 0
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                  : 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                                : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                            }`}
                          >
                            {h.ok ? (h.items.length > 0 ? `חי · ${h.items.length} פריטים` : 'ריק') : `מת · ${h.reason ?? 'fail-closed'}`}
                          </Badge>
                        </div>
                        {h.ok && h.items.length > 0 ? (
                          <ul className="space-y-1.5">
                            {h.items.map((it, i) => (
                              <li key={i} className="text-xs leading-relaxed text-neutral-400">
                                {it.link ? (
                                  <a
                                    href={it.link}
                                    target="_blank"
                                    rel="noreferrer nofollow"
                                    className="underline-offset-2 hover:text-neutral-100 hover:underline"
                                  >
                                    {it.title}
                                  </a>
                                ) : (
                                  it.title
                                )}
                                {it.date && (
                                  <span className="ml-2 text-[10px] text-neutral-600">
                                    {new Intl.DateTimeFormat('he-IL', {
                                      timeZone: 'Asia/Jerusalem',
                                      dateStyle: 'short',
                                    }).format(new Date(it.date))}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-[11px] text-neutral-600">
                            {h.ok ? 'הפיד נגיש אך ריק — אין פריטים להצגה.' : 'הפיד אינו נגיש — נמדד ולא מומצא.'}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </section>

        {/* ---- b3. Position engine room (R346) — the paper book with hard stops ---- */}
        <section aria-label="מנוע-העמדות" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-400">
            <Briefcase className="h-4 w-4 text-emerald-500" aria-hidden />
            <span>
              מנוע-העמדות (נייר) <Num v="R346" className="text-emerald-400" />
            </span>
            <span className="text-neutral-600">· עוצרים קשיחים 2×ATR · RR 1:2 · טיים-סטופ 10 ימים · אפס-הצצה-קדימה</span>
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={loadPositions}
              disabled={positionsLoading}
              className="border-neutral-800 bg-neutral-950 text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
            >
              {positionsLoading ? (
                <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="ml-1 h-3.5 w-3.5" aria-hidden />
              )}
              סמן מחירים
            </Button>
          </div>

          {positionsLoading && !positions ? (
            <Skeleton className="h-64 bg-neutral-900" />
          ) : positionsError ? (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {positionsError}
            </p>
          ) : positions ? (
            <Card>
              <CardContent className="space-y-3 p-4">
                {/* portfolio strip */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
                  <span>
                    פתוחות <Num v={positions.portfolio.openCount} />
                  </span>
                  <span>
                    חשיפה גולמית <Num v={`${positions.portfolio.grossExposurePct}%`} />
                  </span>
                  <span>
                    נטו <Num v={`${positions.portfolio.netExposurePct}%`} />
                  </span>
                  <span>
                    לא-ממומש{' '}
                    <span className={pnlClass(positions.portfolio.unrealizedPct)}>{pctStr(positions.portfolio.unrealizedPct)}</span>
                  </span>
                  <span>
                    ממומש{' '}
                    <span className={pnlClass(positions.portfolio.realizedPct)}>{pctStr(positions.portfolio.realizedPct)}</span>
                  </span>
                  <span>
                    VaR{' '}
                    <Num
                      v={positions.var.ok && positions.var.varPct != null ? `(${Math.round((positions.var.confidence ?? 0.95) * 100)}%) ${positions.var.varPct}%` : '—'}
                      className="text-amber-400"
                    />
                    {!positions.var.ok && positions.var.reason && (
                      <span className="text-neutral-600"> ({positions.var.reason})</span>
                    )}
                  </span>
                </div>

                {/* open actions for the selected symbol — guarded by the live artery */}
                {(() => {
                  const sym = feeds?.symbols.find((s) => s.symbol === symbol)
                  const blocked = !sym || sym.verdict !== 'ALIVE'
                  return (
                    <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
                      <span className="text-xs text-neutral-500">
                        פתיחה עבור <Num v={symbol} className="text-neutral-300" />:
                      </span>
                      <Button
                        size="sm"
                        disabled={positionsBusy || blocked || loading}
                        onClick={() => deskAction({ action: 'open', symbol, side: 'buy' })}
                        className="bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {positionsBusy ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                        פתח לונג
                      </Button>
                      <Button
                        size="sm"
                        disabled={positionsBusy || blocked || loading}
                        onClick={() => deskAction({ action: 'open', symbol, side: 'sell' })}
                        className="bg-rose-700 text-white hover:bg-rose-600 disabled:opacity-50"
                      >
                        פתח שורט
                      </Button>
                      {blocked && (
                        <span className="text-[11px] text-amber-400">
                          {feeds ? `חסום ע\"י-העורק: ${sym?.reason ?? 'סמל לא-חי'} — fail-closed` : 'העורק עוד לא נמדד'}
                        </span>
                      )}
                    </div>
                  )
                })()}

                {positionsMsg && (
                  <p role="status" className="text-xs text-emerald-300">
                    {positionsMsg}
                  </p>
                )}

                {/* the book */}
                <div className="desk-scroll max-h-80 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-neutral-800">
                        <TableHead className="text-neutral-400">סמל</TableHead>
                        <TableHead className="text-neutral-400">צד</TableHead>
                        <TableHead className="text-left text-neutral-400">כניסה</TableHead>
                        <TableHead className="text-left text-neutral-400">עוצר / יעד</TableHead>
                        <TableHead className="text-left text-neutral-400">סימון</TableHead>
                        <TableHead className="text-left text-neutral-400">P&amp;L</TableHead>
                        <TableHead className="text-neutral-400">מצב</TableHead>
                        <TableHead className="text-neutral-400">פעולה</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {positions.positions.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-xs text-neutral-500">
                            הספר ריק — בחר סמל חי ופתח עמדת-נייר.
                          </TableCell>
                        </TableRow>
                      ) : (
                        positions.positions.map((p) => {
                          const pnl = p.status === 'OPEN' ? p.unrealizedPct : (p.realizedPct ?? 0)
                          return (
                            <TableRow key={p.id} className="border-neutral-800/60">
                              <TableCell className="font-mono text-xs text-neutral-200">
                                {p.symbol}
                                <span className="mr-1 text-[10px] text-neutral-500"> {p.sizePct}%</span>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={`px-1.5 py-0 text-[10px] ${
                                    p.side === 'buy'
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                      : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                                  }`}
                                >
                                  {p.side === 'buy' ? 'לונג' : 'שורט'}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-left font-mono text-xs text-neutral-300">
                                {p.entryPrice.toLocaleString('en-US')}
                              </TableCell>
                              <TableCell className="text-left font-mono text-[11px] text-neutral-500">
                                {p.stopPrice.toLocaleString('en-US')} / {p.targetPrice.toLocaleString('en-US')}
                              </TableCell>
                              <TableCell className="text-left font-mono text-xs text-neutral-300">
                                {p.status === 'OPEN' ? p.lastMark.toLocaleString('en-US') : (p.exitPrice ?? p.lastMark).toLocaleString('en-US')}
                              </TableCell>
                              <TableCell className={`text-left font-mono text-xs ${pnlClass(pnl)}`}>
                                {pctStr(pnl)}
                                {p.status === 'CLOSED' && p.closeReason && (
                                  <span className="mr-1 text-[10px] text-neutral-500"> {p.closeReason}</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={`px-1.5 py-0 text-[10px] ${
                                    p.status === 'OPEN'
                                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                      : 'border-neutral-600 text-neutral-400'
                                  }`}
                                >
                                  {p.status === 'OPEN' ? 'פתוחה' : 'סגורה'}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {p.status === 'OPEN' ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={positionsBusy}
                                    onClick={() => deskAction({ action: 'close', id: p.id })}
                                    className="h-7 border-neutral-800 bg-neutral-950 px-2 text-[11px] text-neutral-300 hover:bg-neutral-900"
                                  >
                                    סגור
                                  </Button>
                                ) : (
                                  <span className="text-[11px] text-neutral-600">—</span>
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </section>

        {/* ---- b4. Backtest factory (R346) — real bars, lookahead-free ---- */}
        <section aria-label="מפעל-הבקטסט" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-400">
            <FlaskConical className="h-4 w-4 text-amber-500" aria-hidden />
            <span>
              מפעל-הבקטסט — נתונים חיים <Num v="R346" className="text-amber-400" />
            </span>
            <span className="text-neutral-600">· אות@close(i) → מימוש@open(i+1) · אותו-מנוע-עוצרים כמו-השולחן</span>
            <span className="flex-1" />
            <div className="flex items-center gap-1">
              {(['3mo', '6mo', '1y'] as const).map((r) => (
                <Button
                  key={r}
                  variant="outline"
                  size="sm"
                  onClick={() => setBtRange(r)}
                  className={`h-7 border-neutral-800 px-2 font-mono text-[11px] ${
                    btRange === r ? 'bg-neutral-800 text-neutral-100' : 'bg-neutral-950 text-neutral-400 hover:bg-neutral-900'
                  }`}
                >
                  {r}
                </Button>
              ))}
              <Button
                size="sm"
                onClick={runBacktest}
                disabled={btLoading || loading}
                className="bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {btLoading ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                הרץ על <Num v={symbol} />
              </Button>
            </div>
          </div>

          {btError && (
            <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {btError}
            </p>
          )}

          {bt?.ok && bt.stats ? (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                  {[
                    { l: 'עסקאות', v: String(bt.stats.tradeCount) },
                    { l: 'אחוז-הצלחה', v: bt.stats.hitRate != null ? `${Math.round(bt.stats.hitRate * 100)}%` : '—' },
                    { l: 'Sharpe', v: bt.stats.sharpe != null ? String(bt.stats.sharpe) : '—' },
                    { l: 'תשואה', v: pctStr(bt.stats.totalReturnPct), cls: pnlClass(bt.stats.totalReturnPct) },
                    { l: 'מקס-ירידה', v: `${bt.stats.maxDrawdownPct}%` },
                    { l: 'רווח-ממוצע', v: bt.stats.avgWinPct != null ? pctStr(bt.stats.avgWinPct) : '—' },
                    { l: 'נרות אמיתיים', v: String(bt.bars ?? '—') },
                  ].map((m) => (
                    <div key={m.l} className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                      <p className="text-[10px] text-neutral-500">{m.l}</p>
                      <p className={`font-mono text-sm ${m.cls ?? 'text-neutral-200'}`}>{m.v}</p>
                    </div>
                  ))}
                </div>
                {bt.equity && bt.equity.length > 1 ? (
                  <div>
                    <p className="mb-1 text-[11px] text-neutral-500">
                      עקומת-הון מדומה על נרות אמיתיים (עסקאות × גודל 10%) — <Num v={`sig:${bt.sig ?? ''}`} />
                    </p>
                    <Sparkline closes={bt.equity} stroke="#34d399" label="עקומת-הון בקטסט" />
                  </div>
                ) : null}
                <div className="desk-scroll max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-neutral-800">
                        <TableHead className="text-neutral-400">צד</TableHead>
                        <TableHead className="text-left text-neutral-400">כניסה → יציאה</TableHead>
                        <TableHead className="text-left text-neutral-400">תוצאה</TableHead>
                        <TableHead className="text-neutral-400">סיבת-סגירה</TableHead>
                        <TableHead className="text-neutral-400">אות</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(bt.trades ?? []).map((t, i) => (
                        <TableRow key={i} className="border-neutral-800/60">
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`px-1.5 py-0 text-[10px] ${
                                t.side === 'buy'
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                                  : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                              }`}
                            >
                              {t.side === 'buy' ? 'לונג' : 'שורט'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-left font-mono text-[11px] text-neutral-300" dir="ltr">
                            {t.entryPrice.toLocaleString('en-US')} → {t.exitPrice.toLocaleString('en-US')}
                          </TableCell>
                          <TableCell className={`text-left font-mono text-xs ${pnlClass(t.realizedPct)}`}>
                            {pctStr(t.realizedPct)}
                          </TableCell>
                          <TableCell className="text-[11px] text-neutral-400">{t.closeReason}</TableCell>
                          <TableCell className="text-[11px] text-neutral-500">{t.signal ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-[11px] text-neutral-600">
                  מדידה על היסטוריה אמיתית — לא הבטחת-תשואה. הכישלונות מוצגים כנה (חוק-הענקים).
                </p>
              </CardContent>
            </Card>
          ) : bt && !bt.ok ? null : (
            <p className="text-xs text-neutral-600">בחר סמל והרץ — המנוע ייבחן על נרות-יום אמיתיים מהעורק.</p>
          )}
        </section>

        {/* ---- b5. הספר-הריבוני (R350) — DeFi records for chair decisions ---- */}
        <section aria-label="הספר-הריבוני" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-400">
            <BookOpen className="h-4 w-4 text-amber-500" aria-hidden />
            <span>
              הספר-הריבוני — רשומות DeFi <Num v="R350" className="text-amber-400" />
            </span>
            <span className="text-neutral-600">· deposit · escrow_lock · settle — שלמים-בלבד, שרשרת-חתימות, עוגן ב-saos-dex</span>
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={loadSovereignBook}
              disabled={bookLoading}
              className="h-7 border-neutral-800 bg-neutral-950 px-2 text-[11px] text-neutral-400 hover:bg-neutral-900"
            >
              {bookLoading ? <Loader2 className="ml-1 h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="ml-1 h-3 w-3" aria-hidden />}
              אמת שרשרת
            </Button>
          </div>

          <Panel
            title="ספר-הפסיקות — כל אירוע-עמדה נרשם לנצח"
            icon={<Landmark className="h-4 w-4 text-amber-500" aria-hidden />}
            tag={
              sovereignBook?.chain ? (
                sovereignBook.chain.ok ? (
                  <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[10px] text-emerald-400">
                    שרשרת אומתה · {sovereignBook.chain.count} רשומות
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 px-1.5 py-0 text-[10px] text-rose-400">
                    שרשרת פגועה ב-#{sovereignBook.chain.brokenAt}
                  </Badge>
                )
              ) : null
            }
          >
            {bookLoading && !sovereignBook ? (
              <Skeleton className="h-40 bg-neutral-800" />
            ) : sovereignBook?.ok && sovereignBook.entries.length > 0 ? (
              <div className="space-y-2">
                <div className="desk-scroll max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-neutral-800">
                        <TableHead className="text-neutral-400">seq</TableHead>
                        <TableHead className="text-neutral-400">סוג</TableHead>
                        <TableHead className="text-neutral-400">סמל</TableHead>
                        <TableHead className="text-left text-neutral-400">גודל</TableHead>
                        <TableHead className="text-left text-neutral-400">כניסה → יציאה</TableHead>
                        <TableHead className="text-left text-neutral-400">מימוש</TableHead>
                        <TableHead className="text-neutral-400">חתימה</TableHead>
                        <TableHead className="text-neutral-400">עוגן-דקס</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...sovereignBook.entries].reverse().map((e) => {
                        const price = (mu: number | null) => (mu != null ? (mu / 10000).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—')
                        return (
                          <TableRow key={e.seq} className="border-neutral-800/60">
                            <TableCell className="font-mono text-[11px] text-neutral-500">{e.seq}</TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`px-1.5 py-0 text-[10px] ${
                                  e.kind === 'deposit'
                                    ? 'border-sky-500/40 bg-sky-500/10 text-sky-400'
                                    : e.kind === 'escrow_lock'
                                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                                      : 'border-neutral-600 bg-neutral-800/60 text-neutral-300'
                                }`}
                              >
                                {e.kind === 'deposit' ? 'הפקדה' : e.kind === 'escrow_lock' ? 'נעילת-ערבות' : e.kind === 'settle' ? 'מימוש' : e.kind === 'withdraw' ? 'משיכה' : e.kind}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-[11px] text-neutral-300">
                              {e.symbol ? symbolName(e.symbol) : e.kind === 'deposit' ? 'בסיס-הון' : '—'}
                            </TableCell>
                            <TableCell className="text-left font-mono text-[11px] text-neutral-300">{e.sizeBps != null ? `${(e.sizeBps / 100).toFixed(1)}%` : '—'}</TableCell>
                            <TableCell className="text-left font-mono text-[11px] text-neutral-300" dir="ltr">
                              {e.kind === 'settle' ? `${price(e.entryMu)} → ${price(e.exitMu)}` : price(e.entryMu)}
                            </TableCell>
                            <TableCell className={`text-left font-mono text-xs ${e.realizedBps != null ? pnlClass(e.realizedBps / 100) : 'text-neutral-500'}`}>
                              {e.realizedBps != null ? pctStr(e.realizedBps / 100) : e.kind === 'deposit' ? 'בסיס 100%' : '—'}
                            </TableCell>
                            <TableCell className="font-mono text-[11px] text-neutral-500" dir="ltr">
                              {e.sig}
                            </TableCell>
                            <TableCell className="text-[10px]">
                              {e.mirror === 'OK' ? (
                                <span className="text-emerald-400">ננעל בדקס</span>
                              ) : e.mirror ? (
                                <span className="text-amber-400/80" title={e.mirror}>
                                  {e.mirror.startsWith('REFUSED') ? 'נדחה-דקס' : 'לא-נגיש'}
                                </span>
                              ) : (
                                <span className="text-neutral-600">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
                {!sovereignBook.chain.ok ? (
                  <p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    אימות-אפס-אמון נכשל: {sovereignBook.chain.reasons.join(' · ')} — השרשרת פגועה, הרשומות מוצגות כראיה.
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-600">
                    אימות-אפס-אמון בכל קריאה (schema · seq מונוטוני · prevSig · sig8) — הרשומות הן הראיה, לא ההבטחה. העוגן הריבוני: saos-dex (קבלות חתומות, אפס-ברוקר).
                  </p>
                )}
              </div>
            ) : sovereignBook?.ok ? (
              <p className="text-xs text-neutral-600">הספר ריק — הפקדת-הבסיס תירשם בפעימה-הראשונה של ספר-העמדות.</p>
            ) : (
              <p className="text-xs text-amber-400/80">הספר-הריבוני אינו זמין כרגע — fail-closed, אין ספר מזויף.</p>
            )}
          </Panel>
        </section>

        {/* ---- c. Cabinet row ---- */}
        <section aria-label="הקבינט">
          <div className="mb-3 flex items-center gap-2 text-sm text-neutral-400">
            <Users className="h-4 w-4" aria-hidden />
            הקבינט — חמשת המומחים
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {loading
              ? [0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-44 bg-neutral-900" />)
              : view?.agents
                ? view.agents.map((v) => {
                    const w = status?.weights?.[v.agentId]
                    return (
                      <Card key={v.agentId} className="border-neutral-800 bg-neutral-900 p-4">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold text-neutral-100">{AGENT_NAMES_HE[v.agentId] ?? v.name}</h3>
                          <ActionBadge action={v.action} />
                        </div>
                        <p className="mb-1 text-[11px] text-neutral-500">
                          משקל <Num v={v.weight.toFixed(2)} /> · נצחונות <Num v={w?.wins ?? 0} /> · הפסדים <Num v={w?.losses ?? 0} />
                        </p>
                        <ConfidenceBar value={v.confidence} action={v.action} />
                        <ul className="mt-3 list-disc space-y-1 pr-4 text-[11px] leading-relaxed text-neutral-400">
                          {v.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </Card>
                    )
                  })
                : (
                  <p className="col-span-full text-sm text-neutral-500">
                    עדיין לא התקיים מושב — בחר סימל והרץ כנס מושב.
                  </p>
                )}
          </div>
        </section>

        {/* ---- d. Debate viewer ---- */}
        <Panel title="הדיון — 3 סבבים" icon={<MessageSquare className="h-4 w-4 text-amber-500" aria-hidden />}>
          {view?.debate ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {view.debate.map((round) => (
                <div key={round.round} className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                  <p className="mb-2 text-xs font-semibold text-amber-400">סבב <Num v={round.round} /></p>
                  <ul className="desk-scroll max-h-48 space-y-2 overflow-y-auto pr-1">
                    {round.statements.map((s, i) => (
                      <li key={i} className="text-[11px] leading-relaxed">
                        <span className="font-medium text-neutral-200">{AGENT_NAMES_HE[s.agentId] ?? s.agentId}</span>
                        {' '}
                        <span dir="ltr" className="font-mono text-[10px] text-neutral-500">[{s.stance}]</span>
                        <span className="block text-neutral-400">{s.argument}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">אין דיון להצגה — הרץ מושב.</p>
          )}
        </Panel>

        {/* ---- e. Decision panel + f. Risk gate ---- */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel title={'החלטת היו"ר'} icon={<Scale className="h-4 w-4 text-amber-500" aria-hidden />}>
            {chair ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-6">
                  <div
                    className={`rounded-xl px-6 py-3 text-2xl font-bold ${
                      chair.decision === 'buy'
                        ? 'bg-emerald-500 text-neutral-950'
                        : chair.decision === 'sell'
                          ? 'bg-rose-500 text-neutral-950'
                          : 'bg-neutral-700 text-neutral-100'
                    }`}
                  >
                    {DECISION_HE[chair.decision as Decision] ?? chair.decision}
                  </div>
                  <div className="space-y-1 text-sm">
                    <p className="text-neutral-400">
                      גודל עמדה: <Num v={`${chair.sizePct}%`} className="text-neutral-100" />
                    </p>
                    <p className="text-neutral-400">
                      ביטחון: <Num v={chair.confidence} className="text-neutral-100" />
                    </p>
                    <p className="text-neutral-400">
                      קוורום:{' '}
                      {chair.quorumPassed ? (
                        <span className="font-medium text-emerald-400">עובר</span>
                      ) : (
                        <span className="font-medium text-rose-400">נכשל</span>
                      )}
                    </p>
                  </div>
                </div>
                {view?.outcome && (
                  <p className="text-sm text-neutral-400">
                    תוצאה מדודה (סימולציה):{' '}
                    <Num v={pctStr(view.outcome.realizedPct)} className={`font-bold ${pnlClass(view.outcome.realizedPct)}`} />
                  </p>
                )}
                <ul className="list-disc space-y-1 pr-5 text-xs leading-relaxed text-neutral-400">
                  {chair.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : artifactBroken ? (
              <p className="text-sm text-amber-400">הארטיפקט של המושב האחרון אינו קריא — אין להציג החלטה.</p>
            ) : (
              <p className="text-sm text-neutral-500">אין החלטה — הרץ מושב.</p>
            )}
          </Panel>

          <Panel title="שער-הסיכון — G1..G6" icon={<ShieldCheck className="h-4 w-4 text-amber-500" aria-hidden />}>
            {view?.riskGate ? (
              <>
                <p className="mb-3 text-sm">
                  {view.riskGate.passed ? (
                    <span className="font-medium text-emerald-400">השער עובר — הפוזיציה מאושרת</span>
                  ) : (
                    <span className="font-medium text-rose-400">השער מטיל וטו — אין פוזיציה</span>
                  )}
                </p>
                <ul className="space-y-2">
                  {view.riskGate.checks.map((c) => (
                    <li key={c.id} className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
                      {c.passed ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-label="עובר" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-label="נכשל" />
                      )}
                      <div className="min-w-0 text-xs">
                        <p className="text-neutral-200">
                          <Num v={c.id} /> · {c.label}
                        </p>
                        <p className="mt-0.5 text-neutral-500">
                          מדידה: <Num v={c.measured} className="text-neutral-400" /> · גבול: <Num v={c.limit} className="text-neutral-400" />
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-neutral-500">אין בדיקות שער — הרץ מושב.</p>
            )}
          </Panel>
        </div>

        {/* ---- g. Market snapshot + h. Equity curve ---- */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel title={`תמונת-שוק · ${view?.symbol ?? '—'}`} icon={<Activity className="h-4 w-4 text-amber-500" aria-hidden />}>
            {view?.market ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div>
                    <p className="text-[11px] text-neutral-500">מחיר</p>
                    <Num v={view.market.price} className="text-lg font-bold text-neutral-100" />
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">RSI14</p>
                    <Num v={view.market.rsi14} className="text-lg font-bold text-neutral-100" />
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">ציון-מגמה</p>
                    <Num v={view.market.trendScore} className="text-lg font-bold text-neutral-100" />
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">תנודתיות</p>
                    <Num v={`${view.market.volPct}%`} className="text-lg font-bold text-neutral-100" />
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">SMA20 / SMA50</p>
                    <Num v={`${view.market.sma20} / ${view.market.sma50}`} className="text-sm font-bold text-neutral-100" />
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">משטר</p>
                    <p className="text-sm font-bold text-amber-400">{REGIME_HE[view.regime] ?? view.regime}</p>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <p className="text-[11px] text-neutral-500">120 הסגירות האחרונות</p>
                    <SimTag />
                  </div>
                  <Sparkline closes={view.closes} stroke="#f59e0b" label="גרף קו של 120 הסגירות האחרונות" />
                </div>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">אין תמונת-שוק — הרץ מושב.</p>
            )}
          </Panel>

          <Panel
            title="עקומת-הון"
            icon={<LineChart className="h-4 w-4 text-emerald-500" aria-hidden />}
            tag={<span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] leading-none text-neutral-400">עקומת-הון (סימולציה)</span>}
          >
            {status && status.equity.length > 0 ? (
              <div className="space-y-2">
                <EquityCurve equity={status.equity} />
                <p className="text-xs text-neutral-500">
                  מצטבר: <Num v={pctStr(Math.round(status.equity.reduce((a, b) => a + b, 0) * 10000) / 10000)} className="font-bold text-neutral-200" />{' '}
                  · מושבים: <Num v={status.equity.length} />
                </p>
              </div>
            ) : (
              <p className="text-sm text-neutral-500">אין עדיין עקומת-הון — היא נבנית מהתוצאות המדודות של המושבים.</p>
            )}
          </Panel>
        </div>

        {/* ---- i. Reflexivity panel ---- */}
        <Panel title="רפלקסיביות — אבולוציית משקלים (0.5 עד 2.0)" icon={<Dna className="h-4 w-4 text-amber-500" aria-hidden />}>
          {view?.weightsAfter ? (
            <ul className="space-y-3">
              {view.weightsAfter.map((d) => (
                <li key={d.agentId} className="grid grid-cols-[6.5rem_1fr] items-center gap-3 sm:grid-cols-[9rem_1fr_10rem]">
                  <span className="truncate text-xs text-neutral-200">{AGENT_NAMES_HE[d.agentId] ?? d.agentId}</span>
                  <WeightEvolutionBar before={d.weightBefore} after={d.weightAfter} />
                  <span className="text-[11px] text-neutral-400" dir="ltr">
                    <span className="font-mono">{d.weightBefore.toFixed(2)}</span>
                    <span className="mx-1">{d.weightAfter >= d.weightBefore ? '→' : '←'}</span>
                    <span className={`font-mono font-bold ${d.weightAfter > d.weightBefore ? 'text-emerald-400' : d.weightAfter < d.weightBefore ? 'text-rose-400' : 'text-neutral-300'}`}>
                      {d.weightAfter.toFixed(2)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">אין עדכון משקלים — הרץ מושב.</p>
          )}
        </Panel>

        {/* ---- j. Ledger table ---- */}
        <Panel title="פנקס המושבים — 10 האחרונים" icon={<History className="h-4 w-4 text-amber-500" aria-hidden />}>
          {ledger.length > 0 ? (
            <div className="desk-scroll max-h-80 overflow-y-auto rounded-md border border-neutral-800">
              <Table>
                <TableHeader className="sticky top-0 bg-neutral-900">
                  <TableRow className="border-neutral-800 hover:bg-neutral-900">
                    <TableHead className="text-neutral-400">מושב</TableHead>
                    <TableHead className="text-neutral-400">סימל</TableHead>
                    <TableHead className="text-neutral-400">החלטה</TableHead>
                    <TableHead className="text-neutral-400">גודל</TableHead>
                    <TableHead className="text-neutral-400">תוצאה (סימולציה)</TableHead>
                    <TableHead className="text-neutral-400">חתימה</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.map((row) => (
                    <TableRow key={row.id} className="border-neutral-800">
                      <TableCell><Num v={`#${row.beat}`} className="text-neutral-200" /></TableCell>
                      <TableCell><Num v={row.symbol} className="text-neutral-200" /></TableCell>
                      <TableCell><ActionBadge action={row.decision} /></TableCell>
                      <TableCell><Num v={`${row.sizePct}%`} className="text-neutral-300" /></TableCell>
                      <TableCell><Num v={pctStr(row.realizedPct)} className={`font-bold ${pnlClass(row.realizedPct)}`} /></TableCell>
                      <TableCell><Num v={`sig:${row.sig}`} className="text-[11px] text-neutral-500" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">הפנקס ריק — כל מושב שיורץ יירשם כאן עם חתימת-שרשרת.</p>
          )}
        </Panel>

        {/* ---- k. Briefing card ---- */}
        <Panel title={'תדריך יו"ר (AI)'} icon={<Sparkles className="h-4 w-4 text-amber-500" aria-hidden />}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={runBriefing}
                disabled={briefing.loading || ledger.length === 0}
                variant="outline"
                className="border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
              >
                {briefing.loading ? (
                  <>
                    <Loader2 className="ml-2 h-4 w-4 animate-spin" aria-hidden />
                    מכין תדריך…
                  </>
                ) : (
                  <>
                    <Sparkles className="ml-2 h-4 w-4" aria-hidden />
                    תדריך יו&quot;ר (AI)
                  </>
                )}
              </Button>
              {ledger[0] && (
                <span className="text-xs text-neutral-500">
                  על בסיס מושב <Num v={`#${ledger[0].beat}`} /> · {ledger[0].symbol}
                </span>
              )}
            </div>
            {briefing.ok && briefing.text && (
              <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
                <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-200">{briefing.text}</p>
              </div>
            )}
            {!briefing.ok && (
              <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
                התדריך אינו זמין כרגע
                {briefing.text ? <span className="block text-xs text-amber-500/80">{briefing.text}</span> : null}
              </p>
            )}
          </div>
        </Panel>
      </main>

      {/* ---- l. Footer (sticky bottom) ---- */}
      <footer className="mt-auto border-t border-neutral-800 bg-neutral-950 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-7xl px-4 py-4 text-center text-xs leading-relaxed text-neutral-500">
          saos-desk · R344 · הרשומה חיה בגיט —{' '}
          <a
            href="https://github.com/roshpinacare-sys/saos-desk"
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            className="font-mono text-neutral-400 underline underline-offset-2 hover:text-emerald-400"
          >
            github.com/roshpinacare-sys/saos-desk
          </a>{' '}
          · R345 עורק-הנתונים: אפס מפתחות, סינון אפס-אמון, REFRAIN fail-closed · R346 מנוע-עמדות: עוצרים קשיחים, בקטסט ללא-הצצה · מדוד-מול-מוערך: נתוני-המנוע כאן = סימולציה מתויגת כנה, טבלאות-העורק/העמדות/הבקטסט = נתונים חיים מדודים
        </div>
      </footer>
    </div>
  )
}

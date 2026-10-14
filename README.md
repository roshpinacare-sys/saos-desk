# saos-desk — חדר-הישיבות הריבוני (Sovereign Trading Boardroom, R344)

ריבונות-מסחר אוטונומית: **קבינט סוכנים מתדיין + גרעין-כמותי דטרמיניסטי**, מבוסס-מנדט, נייר-ראשון, בלי מפתחות. נולד מהמחקר של אוקטובר 2026 (ai-hedge-fund · FinRobot · TradingAgents · ATLAS · supercharts) — נעשה ריבוני: הפילוסופיה של FinRobot (המודל מנמק, התוכנה מחשבת), קבינט-המומחים של ai-hedge-fund, checkpoint-resume של TradingAgents, לולאת-הרפלקסיביות של ATLAS — הכל בגרסת-ריבונות: **טהור, חתום, אפנד-אונלי, נייר-קודם, אפס-סודות**.

## הארכיטקטורה

```
[אוניברס: ת"א (.TA) + גלובלי] ──► [snapshot דטרמיניסטי (seed,symbol) — source:sim כנה]
        │                              │
        │        [עורק-חי R345: Yahoo-v8 .TA + RSS עברית — סינון אפס-אמון, REFRAIN כנה]
        ▼                              ▼
[קבינט: הטכני · הערכת-שווי · המומנטום · הסנטימנט · הסיכונים]
        ▼
[דיון 3 סבבים — התכנסות משוקללת דטרמיניסטית]
        ▼
[יו"ר: רוב משוקלל + קוורום] ──► [שער-סיכון G1..G6 — המנדט הקשה]
        ▼                              ▼
[הכרעה: buy/sell/flat + sizePct] ──► [תוצאה מדודה (sim) → רפלקסיביות: משקלים 0.5..2.0]
        ▼
[פנקס אפנד-אונלי שרשרת-חתימות (prevSig) + state snapshot → resume]
```

## מה חי כאן

| מודול | תפקיד |
|---|---|
| `src/kernel.mjs` | PRNG מזורע, סדרות OHLCV, אינדיקטורים (RSI/ATR/SMA/EMA/Bollinger/MACD), sig-canonical |
| `src/agents.mjs` | 5 סוכנים — פסיקות עם ביטחון + סיבות בעברית |
| `src/boardroom.mjs` | דיון 3 סבבים, יו"ר, שער-סיכון G1..G6, דריידאון |
| `src/reflexivity.mjs` | משקלים דרוויניים מתוצאות מדודות, חסום [0.5, 2.0] |
| `src/checkpoint.mjs` | פנקס `state/ledger.jsonl` + `state/beat.json` + אימות-שרשרת + resume |
| `src/ingest.mjs` | **R345** — סינון אפס-אמון, פענוח RSS/Yahoo-v8, מעריך-עורק + REFRAIN, `guardedChair` |
| `src/fetch-live.mjs` | **R345** — מודול-הרשת היחיד: פרובות חיות fail-closed, חתימת `state/feed-latest.json` |
| `src/data.mjs` | אוניברס TASE/גלובלי, פידי-RSS עבריים, פרובות-חיות fail-closed |
| `src/cycle.mjs` | פעימה מלאה אחת → ארטיפקט חתום |
| `selftest.mjs` | וקטורים טהורים — דפוס-ה-selftest של הריבונות |

## הרצה

```bash
bun selftest.mjs              # וקטורים
bun src/cycle.mjs 7 LEUMI.TA  # פעימה אחת
bun src/checkpoint.mjs        # אימות שרשרת-הפנקס
```

## חוקי-השולחן

ראה [`LAWS.md`](LAWS.md) — נייר-קודם · מתמטיקה טהורה/מודל מנמק · המנדט קשה · מדוד-מול-מוערך · פנקס שרשרת · רפלקסיביות חסומה · אפס-סודות · רישום-R344.

## עורק-הנתונים החי (R345) — הוכחה מדודה

הפרובה החיה הראשונה (אפס מפתחות, נקודות-קצה ציבוריות, fail-closed):

| רכיב | מצב מדוד |
|---|---|
| פסיקת-עורק | **ALIVE** — 11/13 סמלים חיים (יחס 84.6% ≥ רצפת-מנדט 70%) |
| סמלים מתים (כנות) | `LEUMI.TA` · `DSEA.TA` — HTTP-404 משני המארחים, DEAD ולא מומצא |
| חדשות עברית חיות | GoogleNews-Hebrew (12 פריטים) · Ynet-Finance (12 פריטים) |
| חדשות מתות (כנות) | Calcalist 403 · Globes 404 · TheMarker 404 |
| חתימת-אטימה | `sig:2d8b59e7` → `state/feed-latest.json` (payload-without-sig) |

```bash
bun src/fetch-live.mjs       # פרובה חיה → חתימת state/feed-latest.json
bun src/cycle.mjs 7 TEVA.TA  # פעימה הנועצת בעורק — feed.verdict בארטיפקט
```

דוקטרינת exec33 (אפס-אמון): ללא מפתחות-חיים; כל בית-חוץ מסונן (הזרקות-פרומפט נתפסות ונספרות); נפילת-פיד/חשד-זיוף = **REFRAIN** — היו"ר נאלץ שטוח עד אישור-בעלים חתום. מערכות-העיון שנסקרו ואומתו חיות: `virattt/ai-hedge-fund` · `AI4Finance-Foundation/FinRobot` · `OpenByteInc/QuantDinger` · `HKUDS/Vibe-Trading` · `e2b-dev/e2b` · `guardrails-ai/guardrails` · `Cozy-Finance/agent-buttercup` · `LLMQuant/awesome-trading-agents` · `Tomortec/CryptoTradingAgents` (Kill-Switch) · `piotrkulpinski/open-source-alternatives`.

## מסילת-הממשק

לוח-המחשב החי (חדר-הישיבות ב-Next.js) צורך את ארטיפקט `saos-desk/session@1` ומציג: קבינט, דיון, הכרעה, שער-סיכון, עקומת-הון, פנקס. המנוע במאגר זה = מקור-האמת; הממשק = עמדת-התצפית.

## הצטיידות-חי (owner-gated, נוכחת במתכונתה בלבד)

ביצוע-חי דורש: (1) mandate.execution.mode=live (2) liveOwnerArmed=true (3) מסילת-ברוקר שתוכתב ע"י הבעלים. היום: **אין מפתח ברוקר, אין חשבון, אין כסף — בכוונה**. המערכת מוכיחה את עצמה בנייר עם שרשרת-ראיות, והנשק ממתין לבעלים.

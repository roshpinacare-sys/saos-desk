# console — עמדת-התצפית החתומה (R345 אטימה)

זהו **מראה-אטימה** של לוח-המחשב החי שרץ בפרויקט-ה-Next.js בסנדבוקס (`src/app/page.tsx` + `src/lib/desk/*` + `src/app/api/desk/*`).
מטרתו: המסילה לא תלך לאיבוד עם הסנדבוקס — הרשומה חיה בגיט (חוק 5 של LAWS.md).

מיפוי:
- `page.tsx` / `layout.tsx` / `globals.css` ← `src/app/`
- `types.ts` `mandate.ts` `engine.ts` `ingest.ts` ← `src/lib/desk/`
- `api/desk/<route>/route.ts` ← `src/app/api/desk/<route>/`

מקור-האמת של המנוע נשאר `src/*.mjs` בריפו זה; הפורט-TS אומת bit-identical (ראה DECISIONS #30 ב-Pulse).
עורק-הנתונים (`ingest.ts` + `api/desk/feeds`) = פורט נאמן של `src/ingest.mjs` (R345).

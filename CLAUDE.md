# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chinese-language novel parsing and creative-fusion tool ("小说创意融合与写作助手" / "Novel Fusion & Generation Assistant"). Pipeline: users upload `.txt` novels → the **client** splits them into chapters → an LLM extracts structured per-chapter analysis (worldview, plot skeleton, characters, relationships, style) → results persist in the browser → users compare chapters side-by-side and fuse multiple parsed chapters into a new outline and full prose.

The whole UI is in Chinese. The app lives in `yaml-write/` (the Next.js root holding `package.json`, `app/`, `api/`, `components/`).

## Commands

Run from `yaml-write/`:

```bash
npm run dev          # concurrently: Next.js (:3000) + FastAPI/uvicorn (:8000)
npm run next-dev     # frontend only
npm run fastapi-dev  # backend only — pip installs requirements.txt, then uvicorn --reload
npm run build        # next build
npm run lint         # next lint
```

There is no test suite.

⚠️ **`fastapi-dev` hardcodes an absolute Windows Python path** (`C:\Users\zerui\...\Python313\python.exe`) in `package.json`. On any other machine `npm run dev`/`fastapi-dev` will fail — point the script at your interpreter (or a venv) first.

Interactive API docs (dev): `http://localhost:3000/api/py/docs` or `http://localhost:3000/docs` — both rewrite to FastAPI's Swagger UI.

## Architecture

### Hybrid Next.js + FastAPI via rewrites

`next.config.js` rewrites `/api/py/:path*` to `http://127.0.0.1:8000/api/py/:path*` in dev and to `/api/` (Vercel Python serverless functions) in production — same-origin in both, so there is **no CORS layer**. Every FastAPI route must keep its `/api/py/` prefix or the rewrite breaks. `/docs` and `/openapi.json` are also rewritten to the FastAPI equivalents.

Next.js native API routes (`app/api/...`) coexist on the same domain but are unrelated to the Python routes. `app/api/helloNextJs/route.ts` and the Python `/api/py/helloFastApi` are leftover starter probes, not used by the app.

### BYOK + multi-provider profiles — keys never touch server storage

`app/store.ts` is the Zustand store with `persist` middleware → everything lives in browser LocalStorage under `novel-fusion-store`. **Every** request to FastAPI carries `apiKey`, `baseUrl`, `model` (and `temperature`) in its body; the backend builds a fresh `OpenAI` client per-request and never persists credentials. Preserve this when adding LLM endpoints.

`llmConfig` has flat fields (`provider`, `apiKey`, `baseUrl`, `model`, `temperature`) **plus** a `providers` record caching `{apiKey, baseUrl, model}` per provider (`openai`/`deepseek`/`gemini`/`siliconflow`/`ollama`/`custom`). `setLlmConfig` logic:
- Changing `provider` → loads that provider's cached creds into the flat fields.
- Editing a flat field → writes it back into the current provider's cache.

The **flat** fields are the source of truth sent to the backend. Note: API keys for *all* configured providers persist in LocalStorage.

The store also holds cross-component selection state: `activeTab`, `selectedNovelId`, `selectedChapterId` (setting a novel clears the chapter).

### Three duplicated schema definitions — keep in sync

1. **`ChapterAnalysis` (+ `Character`, `Relationship`)** — defined in `api/schemas.py` (Pydantic, drives `instructor` extraction) **and** `app/db.ts` (TypeScript, drives storage + UI). Field names must match exactly.
2. **`CharacterBinding`** — defined in `api/schemas.py` **and** inline in `components/FusionEditor.tsx` (it is transient UI state, *not* stored in `db.ts`). The binding types `merge|clash|mentor|custom` and their prompt phrasing live in `api/index.py`.

### Client-side chapter-splitting engine (V2)

All splitting happens in the browser in `components/NovelUploader.tsx` — the backend never sees raw novels.

- **Strategies** (`STRATEGY_REGEX` + `auto_v2`/`custom`): `zh_strict`, `zh_extended`, `mixed`, `en_basic`, `custom`. All regexes match a **single-line** chapter title (`m` flag, no cross-line). `auto_v2` (default on upload) runs every base strategy plus a V2 extra regex, scores each candidate, and picks the best via `selectBetterCandidate` (confidence → chapter count → max-chapter ratio → short-chapter ratio).
- **Quality scoring** (`evaluateSplitQuality`): `titleHitRate`, `continuityScore` (chapter-number monotonicity via `parseChineseNumber`/`extractChapterNumber`), and `distributionScore` (avg/max/short-chapter ratios) combine into `confidence` (0–1) → `confidenceLevel` high(≥0.8)/medium(≥0.58)/low → `splitStatus` becomes `'needs_review'` when low, with `reviewReasons[]` explaining why. All of this is stored on the novel as `splitMeta`.
- **Re-split / repair** (`runResplit`, the "建议智能重切" / 高级修复 UI): low confidence prompts the user to re-split with another strategy or a custom regex. **This reuses the persisted `sourceTextCleaned` and deletes every chapter plus its analysis** before rebuilding — so always populate `sourceTextCleaned` on upload. Custom regexes are validated to be single-line (`validateLineRegex` rejects cross-line constructs) and have `g`/`y` flags stripped.
- **Cleaning** (`cleanText`/`cleanLine`): strips piracy-site watermarks, ad URLs, and HTML entities *before* splitting; the removed-char count surfaces as `purifiedCount`.
- **Encoding** (`detectEncoding`): `jschardet` on the first 50KB; GBK/GB2312/Windows-936 all normalize to GB18030, UTF-16 to UTF-16LE. If UTF-8 decoding yields >1% replacement chars (`�`), it retries as GB18030. Chinese novels in the wild are frequently GBK — do not assume UTF-8.
- **Large files**: max upload 50MB; files >20MB are read in 512KB chunks with a streaming `TextDecoder`; `ensureStorageCapacity` pre-checks `navigator.storage.estimate()`.

### Structured LLM extraction + server-side retry

`api/index.py` `/parse-chapter` uses `instructor.from_openai(...)` with `response_model=ChapterAnalysis` to coerce output into Pydantic. It retries up to 3× with exponential backoff **only** on 429/rate-limit/quota errors; any other error raises immediately → HTTP 500. Reasoning models (DeepSeek R1 / `*reasoner*`) may not support the tool-call/structured output this needs — `SettingsPanel.tsx` surfaces a warning for those.

`parseChaptersInParallel` in `NovelUploader.tsx` runs exactly **3 client-side concurrent workers** pulling from a shared index (the backend has no throttling — change concurrency here). Chapter content is sliced to **15000 chars** before sending. On mount, chapters left in `status:'parsing'` from an interrupted session are reset to `'error'`.

`/test-connection` does a tiny 8s-timeout completion and measures latency; on failure its "智能诊断翻译引擎" maps raw error substrings (401/404/429/timeout/connection-refused) to friendly Chinese diagnostics, returning `{success, message, latency}`.

### Streaming endpoints

`/generate-outline` and `/generate-text` return `StreamingResponse(..., media_type="text/event-stream")` driven by `stream=True`. The frontend (`FusionEditor.tsx`) consumes them with `response.body.getReader()` + `TextDecoder`, appending chunks to React state — despite the `text/event-stream` MIME type, the payload is **raw text chunks, not SSE `data:` frames**. Don't reformat one side without the other. Streaming also dodges Vercel's 10s serverless timeout on long generations — keep it for any new long-running LLM endpoint.

### Local persistence — Dexie / IndexedDB (versioned)

`app/db.ts` defines `NovelFusionDB` with `novels` and `chapters` tables, currently at **schema version 3** (with `.upgrade()` migrations). Any change to the `Novel`/`Chapter` shape requires a new `this.version(n).stores(...).upgrade(...)` block — don't mutate existing version definitions. Parsed `ChapterAnalysis` is stored **inline** on the `Chapter` row, not in a separate table. There is no server-side database. Components read reactively via `useLiveQuery` (`dexie-react-hooks`); mutations through `db.chapters.update(...)` propagate to all live queries automatically.

## Tabs & components

`app/page.tsx` is `'use client'` and switches between three tabs by `activeTab` (Zustand) — no Next sub-routes, SSR is not meaningfully exercised. `SettingsPanel` is a slide-over drawer.

- **NovelUploader** — upload, clean, split (engine above), bulk/parallel LLM parsing, search + status-filter + pagination, re-split repair.
- **ContrastBoard** — A/B side-by-side chapter comparison with **inline-editable** analysis (worldview/plot/style + add/delete characters & relationships), writing back to Dexie. Edit dispatch is keyed by strings like `char-0-personality` / `rel-1-description`.
- **FusionEditor** — 3-step wizard: select parsed chapters + fusion prompt + optional character bindings → edit streamed outline → stream final prose (copy / download as TXT).
- **SettingsPanel** — provider grid, per-provider preset model chips, temperature slider, connection test, R1/reasoner warning.

## Conventions

- Everything is a client component. UI is Tailwind with a dark obsidian/glassmorphism aesthetic (`bg-zinc-900/20`, `backdrop-blur`, zinc palette, indigo/violet accents, `lucide-react` icons). Custom keyframes `animate-slide-in` / `animate-fade-in` are in `app/globals.css`. Match this when adding components.
- `tsconfig.json` defines `@/*` → `./*`, but components import via relative paths (`../app/db`). Follow whichever the neighboring file uses.
- Two lockfiles (`package-lock.json` and `pnpm-lock.yaml`) coexist — use whichever matches the existing `node_modules`; don't add a third.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chinese-language novel **creative-DNA & fusion** tool ("创作 DNA 工坊"). Pipeline: users upload `.txt` novels → the **client** splits them into chapters → a book-level **Map-Reduce** extracts each chapter's creative mutations (Map) and folds them into one whole-book creative-DNA card (Reduce) → users collide 1+ DNA-ready novels into 3 original fusion directions → tweak the 4 setting blocks through a command bar → generate a storyboard → stream chained scene prose. Everything persists in the browser (IndexedDB).

The whole UI is in Chinese. The app lives in `yaml-write/` (the Next.js root holding `package.json`, `app/`, `api/`, `components/`).

## Commands

Run from `yaml-write/`:

```bash
npm run dev          # concurrently: Next.js (:3000) + FastAPI/uvicorn (:8000)
npm run next-dev     # frontend only
npm run fastapi-dev  # backend only — pip installs requirements.txt, then uvicorn --reload
npm run build        # next build (full type-check)
npm run lint         # next lint
npx tsc --noEmit     # type-check only (fast; there is no test suite)
```

There is **no test suite** — validate changes with `npx tsc --noEmit` + `npm run build`, then a manual walk-through. `fastapi-dev` invokes `python` from PATH (`python -m uvicorn api.index:app --reload`); use a venv/interpreter that has the `requirements.txt` deps.

Interactive API docs (dev): `http://localhost:3000/api/py/docs` or `http://localhost:3000/docs` — both rewrite to FastAPI's Swagger UI.

## Architecture

### Hybrid Next.js + FastAPI via rewrites

`next.config.js` rewrites `/api/py/:path*` to `http://127.0.0.1:8000/api/py/:path*` in dev and to `/api/` (Vercel Python serverless functions) in production — same-origin in both, so there is **no CORS layer**. Every FastAPI route must keep its `/api/py/` prefix or the rewrite breaks. `/docs` and `/openapi.json` are also rewritten to the FastAPI equivalents. There are **no Next.js native API routes** — all server logic is the Python FastAPI app (`api/index.py`).

### BYOK + multi-provider profiles — keys never touch server storage

`app/store.ts` is the Zustand store with `persist` middleware → everything lives in browser LocalStorage under `novel-fusion-store`. **Every** request to FastAPI carries `apiKey`, `baseUrl`, `model` (and `temperature`) in its body; the backend builds a fresh `AsyncOpenAI` client per-request and never persists credentials. Preserve this when adding LLM endpoints.

`llmConfig` shape: `activeProvider` (a `ProviderId`) + `providerProfiles` — a `Record<ProviderId, {apiKey, baseUrl, model}>` for `openai`/`deepseek`/`gemini`/`siliconflow`/`ollama`/`custom` (see `app/llmProviders.ts`) — plus a flat `temperature`. Two setters: `setActiveProvider(id)` switches the active provider; `updateActiveProviderProfile(patch)` patches the **active** provider's profile. The active provider's profile is the source of truth sent to the backend; `app/llmClient.ts` (`withLlmPayload` / `postWithLlmConfig` / `ensureLlmConfigReady` / `readApiErrorMessage`) is the single network helper — route new LLM calls through it. API keys for *all* configured providers persist in LocalStorage. (`temperature` is sent and clamped to 0–1.5 but currently has no UI control; it stays at the 0.7 default.)

The store also holds view state: `selectedNovelId`, `workshopOpen` (show `FusionWorkshop`), and `manageMode` (show `NovelUploader`'s chapter list + re-split for the selected novel). `setSelectedNovelId` resets both flags. There are **no tabs** and no cross-component chapter handoff — the right pane is chosen entirely from these three flags in `app/page.tsx` (see Navigation & components).

### Backend hardening (`api/index.py`)

Because the backend proxies user-supplied keys to arbitrary base URLs, it is deliberately defensive — keep these when editing:
- **Per-IP rate limiting** (`ensure_rate_limit` + `RATE_LIMIT_RULES`) with sliding windows (60s) per endpoint based on IP address extracted from `x-forwarded-for` (primary) or client host:
  - `/api/py/extract-chapter-map`: 120 requests / 60s
  - `/api/py/extract-book-reduce`: 10 requests / 60s
  - `/api/py/generate-fusion-directions`: 8 requests / 60s
  - `/api/py/tweak-fusion-blocks`: 20 requests / 60s
  - `/api/py/generate-storyboard`: 12 requests / 60s
  - `/api/py/stream-scene-text`: 12 requests / 60s
- **SSRF guard** (`normalize_base_url` / `validate_base_url` + `DEFAULT_ALLOWED_BASE_URLS`): base URL must be in the allowlist (extendable via `ALLOWED_LLM_BASE_URLS` env), HTTP is only allowed for loopback, private/link-local/etc. IPs are blocked, local hosts only on whitelisted ports (Ollama 11434).
- **Structured errors**: `classify_openai_error` maps OpenAI SDK exceptions to friendly Chinese `ApiError`s; all responses use `{error: {code, message}}`. Don't leak raw upstream errors.

### Duplicated schema definitions — keep in sync

The DNA/fusion data shapes live on both sides and **must match field-for-field (all camelCase)**: `api/schemas.py` (Pydantic, drives `instructor` extraction) ↔ `app/db.ts` + `components/FusionWorkshop.tsx` (TypeScript, drives storage + UI). Synced shapes: `ChapterMapSummary`, `NovelDNACard`, and the fusion `FusionDirection` / `StoryboardScene` / tweak-block shapes. Legacy **`ChapterAnalysis` (+ `Character`, `Relationship`)** now lives **only** in `app/db.ts` as a deprecated, retained field (`Chapter.analysis?`, kept for zero data loss) — the backend no longer has a matching model.

### Client-side chapter-splitting engine (V2)

All splitting happens in the browser in `components/NovelUploader.tsx` — the backend never sees raw novels.

- **Strategies** (`STRATEGY_REGEX` + `auto_v2`/`custom`): `zh_strict`, `zh_extended`, `mixed`, `en_basic`, `custom`. All regexes match a **single-line** chapter title (`m` flag, no cross-line). `auto_v2` (default on upload) runs every base strategy plus `V2_EXTRA_REGEX`, scores each candidate, and picks the best via `selectBetterCandidate` (confidence → chapter count → max-chapter ratio → short-chapter ratio).
- **Quality scoring** (`evaluateSplitQuality`): Computes multiple distinct metrics for candidate evaluation:
  - `titleHitRate`: Fraction of chapters whose titles contain a parseable, well-formed chapter number (matched via `extractChapterNumber` / `parseChineseNumber`).
  - `continuityScore`: Monotonicity score of parsed chapter numbers. Consecutive increases of 1 get `1.0` weight, gaps of 2–3 get `0.6` weight, duplicates get `0.2` weight, and other jumps or failures get `0.0`. Returns `null` if no pairs exist.
  - `distributionScore`: Evaluates chapter lengths and counts. Optimal average size is 300–9000 characters. Incorporates penalty scores for excessive maximum size ratios and high ratios of short chapters (<300 characters).
  - `confidence`: Weighted average of the above scores: `distributionScore` (45%), `titleHitRate` (25%), and `continuityScore` (30%, if available; if not, weights adjust to distribution 64% / title 36%).
  - `confidenceLevel`: Resolves to `'high'` (`>= 0.8`), `'medium'` (`>= 0.58`), or `'low'` (`< 0.58`).
  - `splitStatus`: Becomes `'needs_review'` if `confidenceLevel === 'low'`, else `'ok'`.
  This scoring is **internal only** — it drives the `auto_v2` winner pick and the `needs_review` flag. It is **not** surfaced in the UI: the readiness banner shows just chapter count + avg chars, and (when `splitStatus === 'needs_review'`) a "建议重新切分" hint. The full `splitMeta` (confidence/metrics/reviewReasons) is still persisted on the novel but not displayed.
- **Re-split / repair** (`runResplit`, the 一键智能重切 / 高级修复 UI): re-split with `auto_v2`, another strategy, or a custom regex. **This reuses the persisted `sourceTextCleaned` and deletes every chapter plus its analysis** before rebuilding — so always populate `sourceTextCleaned` on upload. Custom regexes are validated to be single-line (`validateLineRegex`) and have `g`/`y` flags stripped.
- **Cleaning** (`cleanText`/`cleanLine`): strips piracy-site watermarks, ad URLs, and HTML entities *before* splitting; the removed-char count surfaces as `purifiedCount`.
- **Encoding** (`detectEncoding`): `jschardet` on the first 50KB; GBK/GB2312/Windows-936 normalize to GB18030, UTF-16 to UTF-16LE. If UTF-8 decoding yields >1% replacement chars (``), it retries as GB18030. Chinese novels in the wild are frequently GBK — do not assume UTF-8.
- **Large files**: max upload 50MB; files >20MB are read in 512KB chunks with a streaming `TextDecoder`; `ensureStorageCapacity` pre-checks `navigator.storage.estimate()`.

### Book-level DNA: Map-Reduce endpoints + resumable runner

The whole-book DNA and the fusion workshop are served by **6** `/api/py/` endpoints. Five are structured (they share `run_structured` → `instructor.from_openai` + transient retry: up to `MAX_PARSE_RETRIES` (2) extra attempts with exponential backoff on 429/502/503/504, then a friendly `ApiError`); one streams.

| Endpoint | Mode | response_model |
|---|---|---|
| `extract-chapter-map` | structured | `ChapterMapSummaryResponse` |
| `extract-book-reduce` | structured | `NovelDNACardResponse` |
| `generate-fusion-directions` | structured (one mega-prompt → 3 directions) | `FusionDirectionsResponse` |
| `tweak-fusion-blocks` | structured (rewrites only the blocks the instruction hits) | `TweakBlocksResponse` |
| `generate-storyboard` | structured | `StoryboardResponse` |
| `stream-scene-text` | **SSE** | — |

Reasoning models (DeepSeek R1 / `*reasoner*`) may not support the tool-call/structured output `instructor` needs. The creation prompts share `ANTI_SLOP_CONSTRAINT` (a hard anti-cliché rule block), and callers may append free-text `adversarialRules`.

`app/dnaEngine.ts` (`runDnaExtraction(novelId, {limit, signal})`) is the **resumable** Map-Reduce runner: `MAP_CONCURRENCY` (3) workers call `extract-chapter-map` per chapter and persist `mapStatus:'done'` + `mapSummary` immediately (so a refresh/crash never loses progress; re-running skips chapters already `done`). Once every chapter is mapped it folds the summaries into one `NovelDNACard` via `extract-book-reduce`. Progress lives on the novel (`analysisStatus`, `mapProgress`). `NovelDetail.tsx` drives it with an `AbortController` (暂停 = abort → `analysisStatus:'idle'`), exposing 全速提取（前100章）(`limit:100`) vs 深度全量提取 (`limit:undefined`).

> **Vercel 10s note**: `extract-book-reduce` / `generate-fusion-directions` are single large non-streaming calls that can exceed the 10s serverless ceiling on slow models — run heavy extraction under `npm run dev` (local FastAPI, no timeout) or a non-Vercel deploy.

### Streaming endpoint (real SSE)

`stream-scene-text` returns `StreamingResponse(..., media_type="text/event-stream")` and emits SSE frames via `sse_event(...)`: `event: delta|done|error` + `data: {json}`. The frontend consumes it through the shared `streamSse(endpoint, payload, {onDelta, signal})` helper in `app/llmClient.ts` (its `parseSseBuffer` handles `event:`/`data:` framing + JSON payloads); `FusionWorkshop.tsx` uses it to stream each scene's prose, passing `precedingTexts` (the prior 1–2 generated scenes) for continuity. Route any new long-running LLM endpoint through SSE + `streamSse` — it also dodges Vercel's 10s serverless timeout.

### Local persistence — Dexie / IndexedDB (versioned)

`app/db.ts` defines `NovelFusionDB` with versioned schemas and sequential `.upgrade()` migrations:
- **`version(1)`**: Defines initial schema.
  - `novels`: `'id, name, createdAt'`
  - `chapters`: `'id, novelId, chapterIndex, status'`
- **`version(2)`**: Adds `splitStatus` to `novels` (defaults to `'ok'`) and initializes `sourceTextCleaned` to empty string if missing.
  - `novels`: `'id, name, createdAt, splitStatus'`
- **`version(3)`**: Ensures `splitMeta` sub-fields (confidence, confidenceLevel, reviewReasons, selectionMode, winnerStrategyId, engineVersion) are populated and well-typed.
- **`version(4)`**: Normalizes legacy synthetic `splitMeta` structures and sets a valid numeric timestamp in `updatedAt`.
- **`version(5)`**: Introduces book-level Map-Reduce DNA fields.
  - `novels` table schema includes `analysisStatus` (indexable, defaults to `'idle'`), `mapProgress` (`{total, current}`), and `dnaCard` (`NovelDNACard | null`).
  - `chapters` table schema includes `mapStatus` (indexable, defaults to `'pending'`) and `mapSummary` (`ChapterMapSummary`).
  - Schema registry updated to:
    - `novels`: `'id, name, createdAt, splitStatus, analysisStatus'`
    - `chapters`: `'id, novelId, chapterIndex, status, mapStatus'`

Any change to the `Novel`/`Chapter` shape requires a new `this.version(n).stores(...).upgrade(...)` block — don't mutate existing version definitions. There is no server-side database. Components read reactively via `useLiveQuery` (`dexie-react-hooks`); mutations through `db.chapters.update(...)` propagate to all live queries automatically.

## Navigation & components

`app/page.tsx` is `'use client'` with **no tabs and no Next sub-routes** (SSR is not meaningfully exercised). The sidebar is the novel library (each row shows a DNA-status badge via `dnaBadge`); the right pane is chosen from three Zustand flags: `workshopOpen` → `<FusionWorkshop/>`; else `selectedNovelId && !manageMode` → `<NovelDetail/>`; else `<NovelUploader/>`. `SettingsPanel` is a slide-over drawer opened via the `open-settings-panel` window event.

- **NovelUploader** — upload, clean, split (engine above), the re-split repair panel, and a read-only searchable/paginated chapter list. It is both the landing page (no novel selected) and the manage view (`manageMode`). **Makes no LLM calls** — purely the splitting front-end.
- **NovelDetail** — the selected novel's book-DNA board. Left: chapter list with `mapStatus` dots (pending/done/error + a spinner while mapping) and a 重切 button (`setManageMode(true)`). Right: either the DNA-extraction CTA (全速提取（前100章） / 深度全量提取 + a progress bar with 暂停) or, once `analysisStatus==='done'`, the 5 inline-editable DNA cards. Runs `runDnaExtraction` from `app/dnaEngine.ts`.
- **FusionWorkshop** — the 3-step fusion funnel: 引力室 (pick 1+ DNA-ready novels + optional 自定义大方向 / 反套路红队约束 → `generate-fusion-directions`) → three direction cards → creator (the 4 setting blocks + a command bar `tweak-fusion-blocks`, cyan-pulsing the changed blocks → `generate-storyboard` → per-scene streamed prose with copy / save-as-TXT).
- **SettingsPanel** — minimal slide-over: provider dropdown, API key (show/hide), Base URL, model (with `<datalist>` preset suggestions). Nothing else.

(`ContrastBoard` and `FusionEditor` were removed in the DNA-workshop refactor.)

## Conventions

- Everything is a client component. UI is Tailwind with a dark "Linear-style" theme (zinc palette, amber accent, `lucide-react` icons, custom `linear-*` utilities + `animate-slide-in`/`animate-fade-in` keyframes in `app/globals.css`). Match this when adding components.
- `tsconfig.json` defines `@/*` → `./*`, but components import via relative paths (`../app/db`). Follow whichever the neighboring file uses.
- Single lockfile: `package-lock.json` (npm).

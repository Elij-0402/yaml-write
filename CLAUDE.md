# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chinese-language novel parsing and creative-fusion tool ("小说解析与创意融合助手"). Pipeline: users upload `.txt` novels → the **client** splits them into chapters → an LLM extracts structured per-chapter analysis (worldview, plot skeleton, characters, relationships, style) → results persist in the browser → users compare chapters side-by-side and fuse multiple parsed chapters into a new outline and full prose.

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

The store also holds cross-component selection state: `activeTab` (`'upload'|'contrast'|'fusion'`), `selectedNovelId`, `selectedChapterId` (setting a novel clears the chapter), and `fusionSeedChapterIds` — a **one-shot handoff**: ContrastBoard writes the compared chapters into it and switches to the fusion tab; FusionEditor consumes it on mount (pre-selects those chapters) and immediately clears it.

### Backend hardening (`api/index.py`)

Because the backend proxies user-supplied keys to arbitrary base URLs, it is deliberately defensive — keep these when editing:
- **Per-IP rate limiting** (`ensure_rate_limit` + `RATE_LIMIT_RULES`) with sliding windows per endpoint.
- **SSRF guard** (`normalize_base_url` / `validate_base_url` + `DEFAULT_ALLOWED_BASE_URLS`): base URL must be in the allowlist (extendable via `ALLOWED_LLM_BASE_URLS` env), HTTP is only allowed for loopback, private/link-local/etc. IPs are blocked, local hosts only on whitelisted ports (Ollama 11434).
- **Structured errors**: `classify_openai_error` maps OpenAI SDK exceptions to friendly Chinese `ApiError`s; all responses use `{error: {code, message}}`. Don't leak raw upstream errors.

### Two duplicated schema definitions — keep in sync

**`ChapterAnalysis` (+ `Character`, `Relationship`)** is defined twice: `api/schemas.py` (Pydantic, drives `instructor` extraction) **and** `app/db.ts` (TypeScript, drives storage + UI). Field names must match exactly across both.

### Client-side chapter-splitting engine (V2)

All splitting happens in the browser in `components/NovelUploader.tsx` — the backend never sees raw novels.

- **Strategies** (`STRATEGY_REGEX` + `auto_v2`/`custom`): `zh_strict`, `zh_extended`, `mixed`, `en_basic`, `custom`. All regexes match a **single-line** chapter title (`m` flag, no cross-line). `auto_v2` (default on upload) runs every base strategy plus `V2_EXTRA_REGEX`, scores each candidate, and picks the best via `selectBetterCandidate` (confidence → chapter count → max-chapter ratio → short-chapter ratio).
- **Quality scoring** (`evaluateSplitQuality`): `titleHitRate`, `continuityScore` (chapter-number monotonicity via `parseChineseNumber`/`extractChapterNumber`), and `distributionScore` combine into `confidence` (0–1) → `confidenceLevel` → `splitStatus` becomes `'needs_review'` when low. This scoring is **internal only** — it drives the `auto_v2` winner pick and the `needs_review` flag. It is **not** surfaced in the UI: the readiness banner shows just chapter count + avg chars, and (when `splitStatus === 'needs_review'`) a "建议重新切分" hint. The full `splitMeta` (confidence/metrics/reviewReasons) is still persisted on the novel but not displayed.
- **Re-split / repair** (`runResplit`, the 一键智能重切 / 高级修复 UI): re-split with `auto_v2`, another strategy, or a custom regex. **This reuses the persisted `sourceTextCleaned` and deletes every chapter plus its analysis** before rebuilding — so always populate `sourceTextCleaned` on upload. Custom regexes are validated to be single-line (`validateLineRegex`) and have `g`/`y` flags stripped.
- **Cleaning** (`cleanText`/`cleanLine`): strips piracy-site watermarks, ad URLs, and HTML entities *before* splitting; the removed-char count surfaces as `purifiedCount`.
- **Encoding** (`detectEncoding`): `jschardet` on the first 50KB; GBK/GB2312/Windows-936 normalize to GB18030, UTF-16 to UTF-16LE. If UTF-8 decoding yields >1% replacement chars (`�`), it retries as GB18030. Chinese novels in the wild are frequently GBK — do not assume UTF-8.
- **Large files**: max upload 50MB; files >20MB are read in 512KB chunks with a streaming `TextDecoder`; `ensureStorageCapacity` pre-checks `navigator.storage.estimate()`.

### Structured LLM extraction + server-side retry

`api/index.py` `/parse-chapter` uses `instructor.from_openai(...)` with `response_model=ChapterAnalysis` to coerce output into Pydantic. It retries up to `MAX_PARSE_RETRIES` (2) times (3 attempts) with exponential backoff on transient errors (429/502/503/504); other errors become a friendly `ApiError`. Reasoning models (DeepSeek R1 / `*reasoner*`) may not support the tool-call/structured output this needs.

`parseChaptersInParallel` in `NovelUploader.tsx` runs `PARSE_CONCURRENCY_LIMIT` (3) client-side concurrent workers pulling from a shared index (the backend has no client-side throttle — change concurrency here). Chapters over `MAX_CHAPTER_CONTENT_CHARS` (30000) are **rejected** before sending (and the backend enforces the same cap via Pydantic `max_length`) — they are *not* truncated; the user must re-split. On mount, chapters left in `status:'parsing'` from an interrupted session are reset to `'error'`.

### Streaming endpoints (real SSE)

`/generate-outline` and `/generate-text` return `StreamingResponse(..., media_type="text/event-stream")` and emit proper SSE frames via `sse_event(...)`: `event: delta|done|error` + `data: {json}`. The frontend (`FusionEditor.tsx`) consumes them with `response.body.getReader()` + `TextDecoder` and parses frames with `parseSseBuffer` (handles `event:`/`data:` lines, JSON payloads). Keep both sides in sync. Streaming also dodges Vercel's 10s serverless timeout on long generations — keep it for any new long-running LLM endpoint.

### Local persistence — Dexie / IndexedDB (versioned)

`app/db.ts` defines `NovelFusionDB` with `novels` and `chapters` tables, currently at **schema version 4** (with `.upgrade()` migrations). Any change to the `Novel`/`Chapter` shape requires a new `this.version(n).stores(...).upgrade(...)` block — don't mutate existing version definitions. Parsed `ChapterAnalysis` is stored **inline** on the `Chapter` row, not in a separate table. There is no server-side database. Components read reactively via `useLiveQuery` (`dexie-react-hooks`); mutations through `db.chapters.update(...)` propagate to all live queries automatically.

## Tabs & components

`app/page.tsx` is `'use client'` and switches between three tabs by `activeTab` (Zustand) — no Next sub-routes, SSR is not meaningfully exercised. The sidebar nav is numbered `1 · 导入与解析库` / `2 · 横向对比面板` / `3 · 创意融合工坊` to signal the workflow order. `SettingsPanel` is a slide-over drawer.

- **NovelUploader** — upload, clean, split (engine above), bulk/parallel LLM parsing, search + status-filter + pagination, and the re-split repair panel.
- **ContrastBoard** — A/B side-by-side chapter comparison with **inline-editable** analysis (worldview/plot/style + add/delete characters & relationships), writing back to Dexie (edit dispatch keyed by strings like `char-0-personality` / `rel-1-description`). A top **「送入创意融合工坊」** button writes the loaded, parsed chapters into `fusionSeedChapterIds` and switches to the fusion tab.
- **FusionEditor** — 3-step wizard: select parsed chapters (pre-seeded from ContrastBoard) + fusion prompt → edit the streamed outline → stream final prose (copy / download as TXT).
- **SettingsPanel** — minimal slide-over: provider dropdown, API key (show/hide), Base URL, model (with `<datalist>` preset suggestions). Nothing else.

## Conventions

- Everything is a client component. UI is Tailwind with a dark "Linear-style" theme (zinc palette, amber accent, `lucide-react` icons, custom `linear-*` utilities + `animate-slide-in`/`animate-fade-in` keyframes in `app/globals.css`). Match this when adding components.
- `tsconfig.json` defines `@/*` → `./*`, but components import via relative paths (`../app/db`). Follow whichever the neighboring file uses.
- Single lockfile: `package-lock.json` (npm).

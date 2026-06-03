# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chinese-language novel **creative-DNA & skin-swap** tool ("创作 DNA 工坊 / VARIATION ATELIER"). Core theory is **换皮变题** (skin-swap): every story is a migratable **engine** (structure + pacing) wearing a replaceable **skin** (theme + prose). Pipeline: users upload `.txt` novels → the **client** splits them into chapters → a **size-routed** extractor distills the book into one **4-layer engine/skin DNA card** → users pick one DNA-ready book as the **骨架(engine)** and optionally another as the **题材(skin)** (or describe a skin by hand) → the workshop migrates the engine's structure beats onto the new skin into **3 fusion directions** → pick one, the setting auto-repairs logic gaps, tweak the 4 setting blocks (every AI edit shown as an accept/reject diff) → **stream one continuous opening chapter**. Everything persists in the browser (IndexedDB + LocalStorage); there is no server-side database and keys never touch server storage.

The whole UI is in Chinese. The app lives in `yaml-write/` (the Next.js root holding `package.json`, `app/`, `api/`, `components/`).

## Commands

Run from `yaml-write/`:

```bash
npm run dev          # concurrently: Next.js (:3000) + FastAPI/uvicorn (:8000)
npm run next-dev     # frontend only
npm run fastapi-dev  # backend only — pip installs requirements.txt, then uvicorn --reload (excludes *test*)
npm run build        # next build (full type-check)
npm run lint         # next lint
npx tsc --noEmit     # type-check only (fast)
npm test             # vitest run — pure-logic unit tests
```

Tests are **pure-logic only** (Vitest, node env, no React/RTL/jsdom) — the 7 `app/**/*.test.ts` suites cover the extracted pure modules: `splitQuality`, `splitRegex`, `chapterOps`, `dnaSchema`, `dnaRouting`, `diff`, `settingHistory`. Validate changes with `npm test` + `npx tsc --noEmit` + `npm run build`, then a manual walk-through (UI/LLM behavior is not unit-tested). `fastapi-dev` invokes `python` from PATH; use a venv/interpreter that has the `requirements.txt` deps.

Interactive API docs (dev): `http://localhost:3000/api/py/docs` or `http://localhost:3000/docs` — both rewrite to FastAPI's Swagger UI.

## Architecture

### Hybrid Next.js + FastAPI via rewrites

`next.config.js` rewrites `/api/py/:path*` to `http://127.0.0.1:8000/api/py/:path*` in dev and to `/api/` (Vercel Python serverless functions) in production — same-origin in both, so there is **no CORS layer**. Every FastAPI route must keep its `/api/py/` prefix or the rewrite breaks. `/docs` and `/openapi.json` are also rewritten. There are **no Next.js native API routes** — all server logic is the Python FastAPI app (`api/index.py`).

### BYOK + multi-provider profiles — keys never touch server storage

`app/store.ts` is the Zustand store with `persist` middleware → everything lives in browser LocalStorage under `novel-fusion-store`. **Every** request to FastAPI carries `apiKey`, `baseUrl`, `model`, `temperature` in its body; the backend builds a fresh `AsyncOpenAI` client per-request and never persists credentials. Preserve this when adding LLM endpoints.

- `llmConfig` shape: `activeProvider` (a `ProviderId`) + `providerProfiles` — a `Record<ProviderId, {apiKey, baseUrl, model}>` for `openai`/`deepseek`/`gemini`/`siliconflow`/`ollama`/`custom` (registry in `app/llmProviders.ts`: each provider carries `requiresApiKey` + `modelPresets`; `ollama` is `requiresApiKey:false`) — plus a flat `temperature` (default 0.7, clamped 0–1.5). Two setters: `setActiveProvider(id)` and `updateActiveProviderProfile(patch)` (patches the **active** provider). API keys for *all* providers persist.
- **Keys are obfuscated at rest**: the persist `replacer`/`reviver` XOR+base64-encodes every `apiKey` on write (sentinel prefix `x1:`) and restores it on read; in-memory state always holds plaintext, so callers need no changes. Corrupt ciphertext decrypts to `''` (treated as unconfigured, never sent as garbage).
- Writes go through `safeLocalStorage`; a failed write (private mode / quota) flips `persistError` (surfaced as a top-bar "⚠ 存储不可用" hint) instead of being swallowed.
- `STORE_VERSION = 4`; its `migrate` **deletes the removed knobs** `sequencingGear` / `shouldReduceEarly` / `fusionBias` (the old gear/early-reduce/fusion-bias UI is gone) and resets view state.

`app/llmClient.ts` is the **single network helper** — route all LLM calls through it:
- `getActiveLlmRuntimeConfig` / `getLlmConfigError` / `ensureLlmConfigReady` — read & validate the active profile.
- `withLlmPayload` / `postWithLlmConfig` — enrich any payload with `apiKey/baseUrl/model/temperature` and POST. `readApiErrorMessage` unwraps `{error:{code,message}}` into friendly text.
- `callStructured(endpoint, payload, {signal, parse, rateLimitSignal})` — POST a structured (instructor) endpoint; absorbs the repeated 3-step boilerplate: `429 → RateLimitSignal` (unless `rateLimitSignal:false`), `!ok → throw readApiErrorMessage`, else `parse(json)` (a `dnaSchema.parseX` runtime validator) or `json as T`.
- `streamSse(endpoint, payload, {onDelta, onDone?, signal?})` — consume an SSE endpoint (`parseSseBuffer` handles `event:`/`data:` framing; `StreamSseError` carries `{code, resumable}`).
- `RateLimitSignal` lives here (moved out of `dnaEngine` to break a circular import); `dnaEngine.withRateLimitRetry` keys off it.

### Backend hardening (`api/index.py`)

Because the backend proxies user-supplied keys to arbitrary base URLs, it is deliberately defensive — keep these when editing:
- **Per-IP rate limiting** (`ensure_rate_limit` + `RATE_LIMIT_RULES`), sliding 60s windows keyed by `x-forwarded-for` (primary) or client host, per endpoint: see the endpoint table below for limits. Unknown endpoints default to 30/60s.
- **SSRF guard** (`normalize_base_url` / `validate_base_url` + `DEFAULT_ALLOWED_BASE_URLS`): base URL must be in the allowlist (OpenAI / DeepSeek / Gemini / SiliconFlow / Ollama-localhost:11434; extendable via `ALLOWED_LLM_BASE_URLS` env). HTTP only for loopback; private/link-local/reserved/multicast IPs blocked; local hosts only on whitelisted ports (`LOCAL_PORTS = {11434}`).
- **API-key log scrubbing**: `mask_api_key` (→ `sk-***[last4]`) + `scrub_sensitive` (regex over `api_key` fields) — never log plaintext keys; validation-error responses are scrubbed too.
- **Structured errors**: `classify_openai_error` maps OpenAI SDK exceptions to friendly Chinese `ApiError`s; all responses use `{error:{code,message}}`. Don't leak raw upstream errors.

### 4-layer engine/skin DNA — the single shape source (`app/dnaSchema.ts`)

`app/dnaSchema.ts` is the **single source of truth** for the front-end DNA/fusion shapes; `app/db.ts` and `components/FusionWorkshop.tsx` import from it (they used to each redeclare these). **Iron rule:** these shapes mirror `api/schemas.py` (Pydantic, drives `instructor` extraction) **field-for-field, all camelCase** — keep both sides in sync. The file also exports `parseX` runtime validators (`parseChapterMapSummary`, `parseNovelDNACard`, `parseFusionDirection(s)`, `parseStructureBeat`) used as `callStructured`'s `parse` option, so over-the-wire JSON is validated instead of blindly `as T`-cast.

The **`NovelDNACard`** is 4 layers — ①② = migratable **engine**, ③④ = replaceable **skin**:
- ① `structureSkeleton: StructureBeat[]` — typed `{function, summary}` beats (Propp-style functions, theme-neutral, e.g. 「废柴受辱」「获得金手指」).
- ② `pacingSyuzhet: string` — viewpoint/suspense/payoff pacing (engine).
- ③ `themeSkin: string` — genre, worldview rules & costs, core imagery (the replaceable skin).
- ④ `proseStyle: string` — language grain / imagery / cadence (regenerated to fit the new skin on swap).

Other synced shapes: `ChapterMapSummary` (`worldviewUpdates/keyPlotTurns/characterDevelopments/styleObservations`), `FusionDirection` (4 setting blocks + `title/concept/catalyst/transferNote`), and the `SettingBlocks` block keys (`worldviewBlock/protagonistBlock/antagonistBlock/narrativeTone`).

**Legacy 5-dim cards** (`theme/worldview/characters/narrativeStyle/styleFingerprint`) are retained lazily, not migrated (Dexie v9): `db.ts` keeps `LegacyNovelDNACard` + the `isLegacyDnaCard` / `isFourLayerDnaCard` guards, and `Novel.dnaCardVersion` (`1` = legacy, `2` = 4-layer). Re-extracting a novel upgrades it to a v2 card. The deprecated per-chapter `ChapterAnalysis`/`Character`/`Relationship` types still live in `db.ts` (kept on `Chapter.analysis?` for zero data loss) but the backend has no matching model.

### Client-side chapter-splitting engine (V2)

All splitting happens in the browser — the backend never sees raw novels. Pieces:
- **`public/workers/novel-parser-worker.js`** — a *classic* Web Worker (static file, **not** in the webpack graph) that does the actual upload/re-split: `detectEncoding` (jschardet) → decode → `cleanText` → strategy split → quality score → sha. Base strategies `zh_strict`/`zh_extended`/`mixed`/`en_basic` + `V2_EXTRA_REGEX`; `auto_v2` (default) scores every candidate and picks via `selectBetterCandidate`.
- **`app/novelParser.ts`** — wraps that worker's `request → progress → success/error` protocol into a Promise (`parseNovelFile` for upload, `resplit` for re-split). One shared worker lifecycle: 15s watchdog (reset on each progress heartbeat), `terminate` on settle, `AbortSignal` → `AbortError`. (This collapsed ~135 lines of duplicated worker plumbing out of `NovelUploader`.) DB write-back stays in the component.
- **`app/splitRegex.ts`** — custom-regex validation/normalization (`DEFAULT_CUSTOM_REGEX`, `toLineRegex` forces `m` & strips `g/y`, `hasNestedQuantifierRisk`, `validateLineRegex` blocks cross-line & catastrophic-backtracking patterns). `NovelUploader` imports it; the worker still inlines a byte-equivalent copy.
- **`app/splitQuality.ts`** — pure quality scoring (`evaluateSplitQuality`), **dual-copied** with the worker and guarded by the golden-vector test in `splitQuality.test.ts`. Used by the component to **rescore** (`rescoreSplit`) after a manual cut/merge/undo so `splitStatus`/`splitMeta` + the confidence pill stay live (no stale `needs_review`). Metrics: `titleHitRate` (chapters with a parseable number via `extractChapterNumber`/`parseChineseNumber`), `continuityScore` (number monotonicity), `distributionScore` (avg-size 0.35 + max-ratio 0.35 + short-ratio 0.2 + count 0.1; short chapter = **< 120 chars**), folded into `confidence` (distribution 0.45 / title 0.25 / continuity 0.30) → `confidenceLevel` (`high ≥0.8`, `medium ≥0.58`, else `low`). `low` ⇒ `splitStatus:'needs_review'`.
- **`app/chapterOps.ts`** — pure *planning* layer for manual chapter editing: `planStitch` (merge into previous), `planBulkStitch` (merge each contiguous selection into its anchor), `planSplit` (cut one chapter at a line index), `buildStitchBackup` (undo snapshot). No DB/crypto — the component applies a plan inside one `db.transaction` (and runs async sha + `rescoreSplit` there). Lets the index/boundary arithmetic be unit-tested.

`cleanText` strips piracy watermarks/ad URLs/HTML entities before splitting (removed count → `purifiedCount`). `detectEncoding`: GBK/GB2312/Windows-936 → GB18030, BIG5 detection, UTF-16 endianness; retries as GB18030 if UTF-8 yields too many replacement chars. Max upload 50MB; files >20MB read in chunks with a streaming `TextDecoder`.

### Size-routed, resumable DNA extraction (`app/dnaRouting.ts` + `app/dnaEngine.ts`)

Extraction is **zero-parameter and auto-routed by cleaned word count** (no more gear dial / 前100章 vs 全量 buttons). `routeBySize(wordCount)` (`dnaRouting.ts`, pure & unit-tested):
- **`direct`** (≤ 180k chars): whole (or truncated) text in one long-context call → `extract-book-direct` → 4-layer DNA. Skips per-chapter map/reduce.
- **`arc`** (≤ 2M chars): `buildArcWindows` groups consecutive chapters into ~24k-char arc windows; each window → `extract-arc-map` → one `ChapterMapSummary`; then fold all into one card via `extract-book-reduce`.
- **`sampling`** (> 2M chars): `selectSampledWindows` evenly samples ≤ 48 arc windows (always incl. first & last) so a thousand-chapter book doesn't hang. Coverage is `console.info`-logged (no silent truncation).

`runDnaExtraction(novelId, {signal})` is the **resumable** runner. Per-arc summaries persist immediately (`mapStatus:'done'` on the window's lead chapter, `mapSummary` + `mapCompletedAt`), so a refresh/crash never loses progress and re-running skips `done` leads. Concurrency is **fixed** (`3`, or `6` for `sampling`) — the worker pool re-fills as windows complete. A shared 429 helper — **`withRateLimitRetry` + the `RateLimitSignal` sentinel, exported from `dnaEngine.ts` and reused by `FusionWorkshop.tsx`** — silently backs off rate-limited calls (lighting `store.rateLimited`, with an interruptible sleep so 暂停 preempts) instead of failing them. `ensureIncrementalHashes` re-queues only changed chapters (`contentSha256`).

`NovelDetail.tsx` shows the DNA board and **self-heals on mount** (a refresh stranded in `mapping`/`reducing` is reconciled to `idle` + chapters re-queued). The first idle, split-OK, unconfigured-clear novel auto-extracts in the **background** via `useBackgroundExtraction` in `app/page.tsx` (single-flight; survives panel switches; toasts "DNA 就绪" on completion). `NovelDetail` only owns the manual entries: 重新提取 (overwrite) and 继续提取（重试失败处）.

> **Vercel 10s note**: the heavy non-streaming calls (`extract-book-direct` / `extract-book-reduce` / `generate-fusion-directions` / `repair-setting-gaps`) use a 120s backend timeout and can exceed the 10s serverless ceiling on slow models — run heavy extraction under `npm run dev` (local FastAPI, no timeout) or a non-Vercel deploy.

### LLM endpoints (`api/index.py`)

**10** `/api/py/` routes. Nine are structured (shared `run_structured` → `instructor.from_openai` + transient retry: up to `MAX_PARSE_RETRIES` (2) extra attempts with exponential backoff on 429/502/503/504, then a friendly `ApiError`; heavy ones also pass `instructor_retries` 1–2 and a 120s timeout). One streams via SSE. The 4-layer producers share `FOUR_LAYER_DNA_GUIDE`; every creation prompt shares `ANTI_SLOP_CONSTRAINT` and may append free-text `adversarialRules`.

| Endpoint | Mode · `response_model` | Rate/60s | Live caller |
|---|---|---|---|
| `extract-chapter-map` | structured · `ChapterMapSummaryResponse` | 120 | *(retained; off the current runner path)* |
| `extract-arc-map` | structured · `ChapterMapSummaryResponse` | 120 | `dnaEngine` (arc/sampling map) |
| `extract-book-direct` | structured · `NovelDNACardResponse` | 10 | `dnaEngine` (direct route) |
| `extract-book-reduce` | structured · `NovelDNACardResponse` | 10 | `dnaEngine` (reduce) |
| `generate-fusion-directions` | structured · `FusionDirectionsResponse` — migrates `engineCard` beats onto `skinSource` per `mode` (`self`/`cross`) → 3 directions | 8 | `FusionWorkshop` (collide) |
| `repair-setting-gaps` | structured · `RepairSettingGapsResponse` — gap-repair: checks each engine beat survives the new skin, patches breaks | 8 | `FusionWorkshop` (on direction pick) |
| `enhance-instruction` | structured · `EnhanceInstructionResponse` — intent meta-prompt: vague command → precise brief + "我理解你要…对吗" confirm gate | 20 | `FusionWorkshop` (✨ enhance) |
| `tweak-fusion-blocks` | structured · `TweakBlocksResponse` — rewrites only the `targetBlock`, others return `null` | 20 | `FusionWorkshop` (command bar) |
| `stream-scene-text` | **SSE** — per-scene prose; `currentDraft` resumes an interrupted draft | 12 | `FusionWorkshop` (opening + fragment rewrite) |
| `split-recommend` | structured · `SplitRecommendResponse` — JIT semantic split: numbered paragraphs → recommended cut points | 20 | `NovelUploader` |

The old `generate-storyboard` / `stream-storyboard` endpoints and `StoryboardResponse` were **deleted** — the manuscript step is now one continuous opening, so there is no storyboard generation. `extract-chapter-map` still exists for single-chapter mapping but the runner maps by arc-window. Reasoning models (DeepSeek R1 / `*reasoner*`) may not support the tool-call/structured output `instructor` needs (surfaced as a friendly `bad_request`).

### Streaming endpoint (real SSE)

`stream-scene-text` returns `StreamingResponse(..., media_type="text/event-stream")` and emits frames via `sse_event(...)`: `event: delta|done|error` + `data:{json}`. The frontend consumes it through `streamSse` (in `llmClient.ts`); `FusionWorkshop.tsx` uses it twice — to stream the opening chapter (with `currentDraft` for resume/接写) and to rewrite a selected fragment in place. `AbortController` wires the 停止生成 button. Route any new long-running LLM endpoint through SSE + `streamSse` — it also dodges Vercel's 10s timeout.

### Local persistence — Dexie / IndexedDB (versioned)

`app/db.ts` defines `NovelFusionDB` (`novels`, `chapters`, `fusionSessions`) with versioned schemas + sequential `.upgrade()` migrations, currently at **`version(10)`**. Milestones:
- **v1–v4**: novels/chapters base schema; `splitStatus` index; `splitMeta` normalization.
- **v5**: book-level DNA fields — `novels.analysisStatus` (indexed, `'idle'`), `mapProgress`, `dnaCard`; `chapters.mapStatus` (indexed, `'pending'`), `mapSummary`.
- **v6**: optional non-indexed `Chapter.contentSha256` (no-op upgrade; backfilled lazily).
- **v7**: `fusionSessions` table (originally a singleton `'current'`).
- **v8**: `fusionSessions` → multi-record **creation library** (`'id, updatedAt, createdAt'`, adds `name`+`createdAt`); old singleton backfilled.
- **v9**: DNA recut to the **4-layer** card + `FusionSession.settingHistory` (the AI-edit snapshot stack); existing 5-dim cards lazily marked `dnaCardVersion:1` (retained, not migrated). Index strings unchanged.
- **v10**: `FusionSession` drops the deprecated `storyboard` field (the manuscript is a single continuous opening now). Pure type-layer change; no-op upgrade.

`FusionSession` shape: `selectedIds`, `customPrompt`, `adversarialRules`, `step` (`material|directions|creator|manuscript`), `directions`, `blocks`, `directionTitle`, `sceneCount`, `sceneTexts`, `sceneResumeStatus`, `settingHistory?`, plus `name/createdAt/updatedAt`.

**Iron rule:** any change to the `Novel`/`Chapter`/`FusionSession` shape requires a new `this.version(n).stores(...).upgrade(...)` block — don't mutate existing version definitions. Components read reactively via `useLiveQuery` (`dexie-react-hooks`); mutations through `db.*.update(...)` propagate to all live queries.

## Navigation & components

`app/page.tsx` is `'use client'` with **no Next sub-routes** (SSR is not meaningfully exercised). A top **`WorkflowStepper`** (`components/WorkflowStepper.tsx`, driven by `getNovelWorkflowSummary` in `app/workflow.ts`) renders the main-line stage gate — **导入 → 切分 → DNA → 变体** — with per-stage status and click-to-navigate. The right pane is still chosen from Zustand flags: `workshopOpen` → `<FusionWorkshop/>`; else `selectedNovelId && !manageMode` → `<NovelDetail/>`; else `<NovelUploader/>`. The sidebar holds the **作品 library** (status dot per row) **and a 创作 library** (saved fusion runs filtered to `creator`/`manuscript`/has-prose; `+ 新建创作` mints a fresh `crypto.randomUUID()`). `SettingsPanel` is a slide-over opened via the `open-settings-panel` window event (or ⌘/Ctrl+,). `workshopBusy` blocks switching/creating a creation mid-stream.

- **NovelUploader** — upload, clean, split (engine above), the re-split repair panel + JIT `split-recommend`, and a paginated chapter list with the cut/merge tools (`chapterOps`). Both the landing page and the manage view (`manageMode`). Its credential **crystal card** uses the shared editor (`variant="crystal"`, `providerSelector="tabs"`, + an Ollama heartbeat slot). Makes no DNA/fusion LLM calls beyond `split-recommend`.
- **NovelDetail** — the selected novel's DNA board: auto/background extraction status + progress, self-heal-on-mount, 重新提取 / 重试失败处, and the rendered DNA card (4-layer engine/skin cards, or a legacy 5-dim card with an "升级" hint). Runs `runDnaExtraction`.
- **FusionWorkshop** — the 4-step skin-swap funnel, persisted **per creation** to `db.fusionSessions` (keyed by `activeCreationId`):
  1. **配方台 (material)** — pick the **骨架(engine)** book (must be a 4-layer card) and optionally a **题材(skin)** book; `selectedIds[0]`=engine, `[1]`=skin. `mode` = `cross` (two books) or `self` (自我裂变, skin from `customPrompt`). `swapRoles` ⇅; optional 想往哪写 + 反套路约束. → `generate-fusion-directions`.
  2. **三方向 (directions)** — 3 migration directions, each with a `transferNote` (🧬 which engine beat → which skin).
  3. **创世台 (creator)** — read-only engine source (①②) + 4 editable setting blocks; picking a direction auto-runs `repair-setting-gaps` (🩹 补洞). AI edits go command-bar → `tweak-fusion-blocks` → **diff** (`app/diff.ts`) → accept/reject (never silent overwrite); ✨ → `enhance-instruction` confirm gate; manual ✎ edit; **version history** (`settingHistory` via `app/settingHistory.ts`, 一键回退).
  4. **成稿 (manuscript)** — one continuous opening chapter streamed via `stream-scene-text` (停止 / 重写 / 继续接写 / 复制 / 导出 .md). Selecting a sentence triggers an in-place AI rewrite (preview → accept/reject). A client-side `applyAntiSlopFallback` is a backstop to the backend prompt constraint.
- **ProviderCredentialsEditor** (`components/ProviderCredentialsEditor.tsx`) — the **shared** credential-form core + store wiring (`activeProvider`/profile/setters). Hosts supply only a shell + a `variant` theme (`minimal` | `crystal`), a `providerSelector` (`select` | `tabs`), and an optional `ollamaSlot`. Consumed by `SettingsPanel` (`minimal`/`select`) and `NovelUploader`'s crystal card (`crystal`/`tabs`).
- **SettingsPanel** — minimal slide-over: readiness line + `<ProviderCredentialsEditor variant="minimal" providerSelector="select"/>` + a "keys stay local" note. (The global temperature slider was removed; temperature defaults to 0.7.)

(`ContrastBoard` / `FusionEditor` and the whole storyboard/分镜 flow were removed in the skin-swap redesign. `store.engineNovelId`/`skinNovelId` exist but are currently unused — the recipe uses `FusionWorkshop`'s local `selectedIds`.)

## Conventions

- Everything is a client component. The UI is a custom **朱墨 / 宣纸 "atelier"** design system: CSS-variable tokens (`--vermilion`, `--paper-text`, `--ink-dim`, `--add`/`--del` for diffs, `--font-serif`…) + ~40 semantic component classes (`.atelier`, `.eyebrow`, `.lede`, `.cta`, `.setcard`, `.slab`, `.recipe`, `.studio`, `.manuscript`…) defined in `app/globals.css`; the chrome (sidebar/top bar/stepper) uses Tailwind utilities with zinc/amber/emerald status accents. Match the surrounding file. `lucide-react` is installed but **no longer used** — icons are inline glyphs/emoji (墨, ✂︎, ✨, 🔧, 🎨, →). Respect `prefers-reduced-motion`.
- **Iron rules** (the codebase enforces these by comment & test): keep `app/dnaSchema.ts` ↔ `api/schemas.py` field-for-field camelCase; bump a new Dexie `version(n)` block for any stored-shape change; route LLM calls through `app/llmClient.ts` (`callStructured`/`streamSse`/`postWithLlmConfig`); keep `splitRegex.ts`/`splitQuality.ts` byte-equivalent with the worker copy (golden-vector test); preserve backend hardening (rate limit, SSRF, key masking, friendly errors); never persist keys server-side.
- `tsconfig.json` defines `@/*` → `./*`, but components import via relative paths (`../app/db`). Follow whichever the neighboring file uses.
- Single lockfile: `package-lock.json` (npm).

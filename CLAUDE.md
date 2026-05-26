# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chinese-language novel parsing and creative-fusion tool ("小说创意融合与写作助手"). Users upload `.txt` novels, the system splits them by Chinese chapter markers, has an LLM extract structured analysis (worldview, characters, relationships, plot, style), persists results locally, and then fuses multiple parsed novels into new outlines and prose.

Detailed product/architectural intent is in `prd.md` (Chinese).

## Commands

```bash
npm run dev          # concurrently runs Next.js (:3000) and FastAPI/uvicorn (:8000)
npm run next-dev     # frontend only
npm run fastapi-dev  # backend only — also runs `pip install -r requirements.txt`
npm run build        # next build
npm run lint         # next lint
```

There is no test suite configured.

Interactive API docs: `http://localhost:3000/api/py/docs` (proxied to FastAPI's Swagger UI).

## Architecture

### Hybrid Next.js + FastAPI via rewrites

`next.config.js` rewrites `/api/py/:path*` to `http://127.0.0.1:8000/api/py/:path*` in dev and to `/api/` (Vercel Python serverless functions) in production. Same-origin in both environments — there is no CORS layer. FastAPI must keep its `/api/py/` prefix on every route or the rewrite breaks.

Next.js native API routes (`app/api/...`) coexist with the Python routes on the same domain — they are unrelated mechanisms, both reachable from the frontend.

### BYOK (Bring Your Own Key) — keys never touch the server's storage

`app/store.ts` is the Zustand store with `persist` middleware → API key, base URL, model, and temperature live in browser LocalStorage under `novel-fusion-store`. **Every** request to the FastAPI backend includes `apiKey`, `baseUrl`, `model` in its body; the backend constructs a fresh `OpenAI` client per-request and never persists credentials. Preserve this pattern when adding new LLM-calling endpoints.

### Structured LLM extraction

`api/index.py` `/parse-chapter` uses `instructor.from_openai(...)` with `response_model=ChapterAnalysis` to coerce LLM output into a Pydantic schema. The schema is defined twice — once in `api/schemas.py` (Pydantic) and once in `app/db.ts` (TypeScript interfaces). **These two must stay in sync** when fields change.

### Streaming endpoints

`/generate-outline` and `/generate-text` return `StreamingResponse(..., media_type="text/event-stream")` driven by `stream=True` on the OpenAI client. The frontend (`FusionEditor.tsx`) consumes them with `response.body.getReader()` + `TextDecoder` and appends chunks to React state — note that despite `text/event-stream`, the payload is **raw text chunks, not SSE-formatted `data:` frames**. Don't reformat one side without the other.

Streaming exists partly to avoid Vercel serverless 10s timeouts on long generations; keep streaming for any new long-running LLM endpoint.

### Local persistence — Dexie / IndexedDB

`app/db.ts` defines `NovelFusionDB` with `novels` and `chapters` tables. Parsed `ChapterAnalysis` is stored inline on the `Chapter` row (`analysis?: ChapterAnalysis`), not in a separate table. Components use `useLiveQuery` from `dexie-react-hooks` for reactive reads — mutations via `db.chapters.update(...)` propagate to all live queries automatically. There is no server-side database.

### Chapter splitting and encoding

`components/NovelUploader.tsx`:
- `splitNovel()` uses the regex `/^\s*(第\s*[一二三四五六七八九十百千万零\d]+\s*[章节回卷折篇幕].*?)$/gm` to detect chapter boundaries. If no match, the whole file becomes one chapter.
- `cleanText()` strips common Chinese piracy-site watermarks, ad URLs, and HTML entities **before** splitting. The count of stripped chars is surfaced in the UI as `purifiedCount`.
- `readTextWithEncodingCheck()` uses `jschardet` on the first 50KB to pick between UTF-8 and GB18030 (Windows-936 / GBK / GB2312 all normalized to GB18030). If UTF-8 decoding produces >1% replacement chars (`�`), it retries as GB18030. Chinese novels in the wild are frequently GBK — do not assume UTF-8.

### Parsing concurrency

`parseAllChapters()` in `NovelUploader.tsx` spawns exactly 3 concurrent workers pulling from a shared index. This rate-limit is client-side only; the backend has no throttling. If you change concurrency, change it here.

### Chapter content truncation

`parseChapter()` slices chapter content to `15000` chars before sending to `/parse-chapter` to bound token usage. Long chapters are silently truncated.

## Conventions

- Tab routing lives entirely in Zustand (`activeTab` in `app/store.ts`) — `app/page.tsx` switches between `NovelUploader`, `ContrastBoard`, `FusionEditor` based on it. There are no Next.js sub-routes for tabs.
- Frontend is all client components (`'use client'` at top of `app/page.tsx`); the App Router is used but SSR is not exercised meaningfully.
- UI is Tailwind with a dark obsidian/glassmorphism aesthetic (`bg-zinc-950/85 backdrop-blur-2xl`, indigo/purple gradients, `lucide-react` icons). Match this when adding components.
- Two lockfiles exist (`package-lock.json` and `pnpm-lock.yaml`); the repo was initialized with npm but pnpm has been used. Prefer the one that matches the existing `node_modules` state — don't add a third.

# Issue 04：统一 reconcile（self-heal 与 resume 并轨）

Status: ready-for-agent
Category: enhancement

## Parent

`.scratch/dna-extraction-state-machine/PRD.md`

## What to build

本 PRD 的核心 correctness 切片——把分裂不变量的**后向一半**（self-heal）收到运行器/模块接口后面，与前向半（resume）并轨。

- 加纯函数 `planReconcile(novel, chapters)` → `复位计划 | null`：若书被刷新/崩溃滞留（`isExtracting` 为真但无在跑任务），返回 `{ nextAnalysisStatus: 'idle', resetChapterIds: 所有 mapStatus==='mapping' 的章节 id }`；否则返回 `null`。
- 运行器导出薄 `reconcileExtraction(novelId)`：读 novel + chapters → 调 `planReconcile` → 在单个 `db.transaction` 内应用复位计划（`analysisStatus → idle`，`mapping` 章节 → `pending`）。
- `NovelDetail` 的挂载对账不再内联 `db.novels.update` + `db.chapters.modify`，改为调用 `reconcileExtraction(novelId)`。

自此前向（resume 跳过 `done`）与后向（reconcile 复位 `mapping → pending`）共用同一组判定、同住一个接口后面，无法再独立漂移。

端到端可演示：提取途中刷新/崩溃 → 书恢复 idle、滞留章节重新入队、续跑跳过已完成项、最终完成。

## Acceptance criteria

- [x] `planReconcile(novel, chapters)` 为纯函数，golden 单测覆盖：滞留于 `mapping` → 复位计划；滞留于 `reducing` → 复位计划；干净 `done` → `null`；`idle` → `null`；`error` → `null`。
- [x] 复位计划的 `resetChapterIds` 恰为 `mapStatus==='mapping'` 的章节（`done` 章节不动，确保续跑跳过它们）。
- [x] `reconcileExtraction(novelId)` 在单个事务内应用复位（`analysisStatus → idle`、`mapping` 章节 → `pending`）。
- [x] `NovelDetail` 挂载对账改为调用 `reconcileExtraction`，不再内联 db 写。
- [ ] 手动走查：提取途中刷新/崩溃 → 书恢复 `idle`、`mapping` 章节回 `pending`、续跑跳过 `done` lead、最终 `done` 且 `dnaCard` 就位。
- [x] 不改已落库形状；不升 Dexie 版本。
- [x] `npm test` + `npx tsc --noEmit` + `npm run build` 通过。

## Blocked by

- `.scratch/dna-extraction-state-machine/issues/01-predicates-and-read-site-migration.md`（模块在 #01 创建）
- 建议在 `.scratch/dna-extraction-state-machine/issues/03-resume-target-selection.md` 之后落地：让前向+后向并轨连贯，并减少对 `dnaEngine` 的冲突。

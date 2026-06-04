# Issue 03：resume 目标选择 `selectResumeTargets`

Status: ready-for-agent
Category: enhancement

## Parent

`.scratch/dna-extraction-state-machine/PRD.md`

## What to build

把可续跑运行器里内联的「跳过 lead 已 `mapStatus==='done'` 的窗口」过滤逻辑，提成纯函数 `selectResumeTargets(units, chaptersById)`——这是统一不变量的**前向一半**。运行器（`runDnaExtraction`）改为调用它来挑待跑的 arc 窗口。

端到端行为对齐：对一本已部分映射的书重跑提取时，已完成的 arc 窗口被跳过、不重做、不浪费 API 配额。限流退避（`withRateLimitRetry` / `RateLimitSignal`）与 size-routing 一律不动。

## Acceptance criteria

- [x] `selectResumeTargets(units, chaptersById)` 为纯函数，恰好返回 lead 不为 `'done'` 的那些 units。
- [x] `runDnaExtraction` 用它做 resume 目标选择，替换内联过滤。
- [x] golden-vector 单测覆盖：done/非 done 混合、全 done（返回空）、全非 done（原样返回）。
- [ ] 手动走查：对部分映射的书重跑，已完成 arc 窗口被跳过；`withRateLimitRetry` 退避行为不变。
- [x] 不改已落库形状；`npm test` + `npx tsc --noEmit` + `npm run build` 通过。

## Blocked by

- `.scratch/dna-extraction-state-machine/issues/01-predicates-and-read-site-migration.md`（模块在 #01 创建）

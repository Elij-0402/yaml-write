# Issue 02：后台自启门 `canAutoStart`

Status: ready-for-agent
Category: enhancement

## Parent

`.scratch/dna-extraction-state-machine/PRD.md`

## What to build

给提取状态模块加上 `canAutoStart`（状态层判定：`idle` 且无 `dnaCard`），并把 `useBackgroundExtraction` 里内联的自启门改成调用它。组件继续拥有其余附加门（split-OK、配置清白、single-flight、面板切换存活、完成 toast）——本切片只把「状态那一截」收编。失败（`error`）的书绝不被自动重启。

端到端行为对齐：后台自动提取只在书真正可自启时起跑，不重复起跑、不重启 error。

## Acceptance criteria

- [x] `canAutoStart(novel)` ⇔ `analysisStatus === 'idle'` 且无 `dnaCard`，从模块导出并有 golden 单测。
- [x] `useBackgroundExtraction` 用 `canAutoStart` 取代内联的 `analysisStatus !== 'idle' || dnaCard` 判断。
- [x] 后台自动提取仅对真正 idle、未配置清白、切分 OK 的书起跑；绝不对已在进行的任务重复起跑；绝不重启 `error` 的书。
- [x] single-flight、面板切换途中任务存活、「DNA 就绪」完成 toast 行为保持不变。
- [x] 不改已落库形状；`npm test` + `npx tsc --noEmit` + `npm run build` 通过。

## Blocked by

- `.scratch/dna-extraction-state-machine/issues/01-predicates-and-read-site-migration.md`（模块在 #01 创建）

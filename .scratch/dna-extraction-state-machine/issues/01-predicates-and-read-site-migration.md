# Issue 01：判定式 + 读取点迁移

Status: ready-for-agent
Category: enhancement

## Parent

`.scratch/dna-extraction-state-machine/PRD.md`

## What to build

纯「提取状态」决策模块在本切片诞生。引入三个只读判定/投影：`isDnaReady`、`isExtracting`、`dnaPhase`，作为「这本书 DNA 处于什么阶段」的单一事实源。然后把当前散落、内联手抄这些判断的**全部读取点**改成调用该模块——侧栏「就绪」计数、配方台骨架/题材挑选、WorkflowStepper 的 stage 投影、首页的阶段派生与就绪计数、以及重切修复的「提取中禁止」防护。

纯重构、行为对齐：UI 显示与现状逐处一致，不改任何已落库形状、不升 Dexie 版本。这是证明「模块抽取」模式端到端跑通的探路弹。

## Acceptance criteria

- [x] 一个纯模块（无 React / Dexie / 网络依赖）导出 `isDnaReady(novel)`、`isExtracting(novel)`、`dnaPhase(novel)`。
- [x] 语义：`isDnaReady` ⇔ `analysisStatus === 'done'` 且存在 `dnaCard`；`isExtracting` ⇔ `analysisStatus ∈ {mapping, reducing}`；`dnaPhase` 返回 `'idle' | 'extracting' | 'ready' | 'error'` 之一。
- [x] workflow.ts、page.tsx、NovelDetail、FusionWorkshop、NovelUploader 中所有此前内联的同类判断，改为调用模块，不再直接比较原始状态字符串。
- [x] 纯逻辑 Vitest 套件新增 golden-vector 单测，覆盖 idle / extracting（`mapping` 与 `reducing` 各一）/ ready / error 下每个判定式与 `dnaPhase`。
- [ ] WorkflowStepper、DNA 板、配方台挑选、重切防护对「就绪 / 提取中」的判断与改动前完全一致（parity，可视觉走查）。
- [x] 不改 `Novel` / `Chapter` 形状；不新增 Dexie 版本。
- [x] `npm test` + `npx tsc --noEmit` + `npm run build` 通过。

## Blocked by

None - can start immediately.

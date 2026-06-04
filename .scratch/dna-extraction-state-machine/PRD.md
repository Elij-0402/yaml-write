# PRD：深化 DNA 提取状态机（统一 resume 与 self-heal 不变量）

Category: enhancement
Status: parent-spec  （父 PRD：不参与 agent state 机；triage 状态见 issues/ 下 4 个子 issue）

> 来源：架构评审首推候选 #1（见临时报告 `architecture-review-*.html`）。这是一次**深化重构**，目标是行为对齐（parity）下把散落的状态机规则收成单一深模块——不改任何已落库形状、不改 LLM 端点、不做 UI 改版。

## Problem Statement

作为维护者，我面对的是：一本小说的 DNA 提取状态机——`Novel.analysisStatus`（`idle → mapping → reducing → done | error`）加上每章 `Chapter.mapStatus`（`pending → mapping → done | error`）——它的**转移与解读规则被复制散落在至少 6 个模块里**：`dnaEngine` 的运行器（前向转移 + resume 跳过 `done`）、`NovelDetail` 的挂载 self-heal（后向：`mapping/reducing → idle`、章节 `mapping → pending`）、`page.tsx` 的后台自启门与 `dnaPhase` 派生、`workflow.ts` 的 stage 投影、`NovelUploader` 的重切防护、`FusionWorkshop` 的「DNA 就绪」挑选。其中 `isDnaReady`（`analysisStatus==='done' && dnaCard`）出现 ≥5 处、`isExtracting`（`mapping || reducing`）≥4 处，全是手抄的字符串比较。

后果有二：

- **locality 缺失**：要新增/重命名一个状态（例如加一个 `paused`），得改 4–6 处；漏改任何一处都不会让 CI 失败。
- **correctness 风险**：resume（前向，运行器里）与 self-heal（后向，组件里）是**同一条不变量的两半却分居两个模块**。一旦二者漂移——比如有人给运行器加了新状态却忘了更新 self-heal——刷新/崩溃后会留下孤儿章节（卡在 `mapping` 的章节既不被复位也不被续跑），DNA 状态与真实进度不一致。

作为读者，我感受到的是：上传一本书、提取途中刷新或崩溃后，书可能卡在「提取中」却没有任何在跑的任务；或者重新提取时本该跳过的已完成 arc 窗口被重做、本该续跑的章节被跳过。

## Solution

把状态机的**解读与转移规则收进一个纯决策模块**，作为关于「这本书处于什么阶段 / 能不能自启 / 崩溃后该怎么复位 / 续跑该跑哪些」的单一事实源。运行器、self-heal、后台门、workflow 投影、重切防护、融合就绪挑选，全部改成调用这个模块的判定式与计划函数，不再各自 `switch` 原始状态串。

关键是把那条分裂的不变量并到一处：**「状态为 extracting 但当前没有在跑的任务」⇒ 视为被刷新/崩溃滞留 ⇒ 复位到 `idle` 并把卡在 `mapping` 的章节退回 `pending`**，这样可续跑的运行器再次启动时会跳过 `done` 的 lead、重跑其余。前向（resume 目标选择）与后向（reconcile 复位计划）都成为同一模块里的纯函数，可被 golden vector 单测。

对读者而言行为**完全对齐现状**：崩溃恢复、续跑、后台自启、stage 显示、就绪挑选都保持原样，只是不再会漂移出 bug。

## User Stories

1. 作为维护者，我想让提取状态机的转移规则集中在一个模块里，这样新增或重命名一个状态时只改一处，而不是 4–6 处。
2. 作为维护者，我想要单一的 `isDnaReady` 判定式，这样「DNA 就绪」在侧栏计数、配方台骨架/题材挑选、WorkflowStepper、后台自启门之间不会出现分歧。
3. 作为维护者，我想要单一的 `isExtracting` 判定式，这样「提取进行中」在后台门、stage 投影、重切防护处被判得完全一致。
4. 作为维护者，我想让 self-heal（后向）与 resume（前向）逻辑落在同一个接口后面，这样二者无法静默漂移、不会再滞留章节。
5. 作为维护者，我想把 reconcile（崩溃/刷新复位）决策做成纯函数，这样无需浏览器或 IndexedDB 就能单测恢复逻辑。
6. 作为维护者，我想把 resume 目标选择（跳过 `done` 的 lead）做成纯函数，这样续跑可被 golden vector 验证，和 `dnaRouting` 一样。
7. 作为维护者，我想让调用方不再 `switch` 原始 `analysisStatus`/`mapStatus` 字符串，这样合法状态集由模块强制，而非散落的字符串比较。
8. 作为维护者，我想让 WorkflowStepper 的 stage 投影消费共享的阶段派生，这样 stepper 与首页对 DNA 阶段的判断永远一致。
9. 作为维护者，我想要本次不改 `Novel`/`Chapter` 的已落库形状，这样无需新增 Dexie `version(n)` 或迁移。
10. 作为维护者，我想让限流退避（`withRateLimitRetry` + `RateLimitSignal`）保持在它现有的 seam 后面不动，这样深化不会回退退避行为。
11. 作为维护者，我想让手动内容编辑触发的重置（拼接/切分把 `mapStatus` 置 `pending`）继续生效，这样被编辑的章节仍会被重新映射。
12. 作为 AFK agent，我想让这个提取状态模块成为状态类问题的唯一 import 点，这样我以后能从一个文件自信地扩展状态机。
13. 作为 AFK agent，我想让纯决策函数被 golden vector 覆盖，这样恢复/续跑的回归会在 `npm test` 阶段、而非手动 QA 阶段就变红。
14. 作为读者，我想让一本被刷新或崩溃滞留在提取途中的书恢复到干净状态，这样我能重新触发提取而不留下孤儿章节。
15. 作为读者，我想让崩溃时正卡在 `mapping` 的章节被重新入队，这样续跑会完成它们而不是跳过。
16. 作为读者，我想让已映射完成的 arc 窗口在续跑时被跳过，这样重跑不会重做已完成的工作、不浪费 API 配额。
17. 作为读者，我想让后台自动提取只在书真正 `idle` 且未配置清白时才启动，这样它绝不会对一个已在进行的任务重复起跑。
18. 作为读者，我想让 WorkflowStepper 显示的「DNA 提取中 / 就绪」与书详情 DNA 板一致，这样阶段门永不与 DNA 板自相矛盾。
19. 作为读者，我想让配方台的骨架/题材挑选恰好只列出 DNA 已就绪的书，这样我无法选到 DNA 其实没完成的书。
20. 作为读者，我想让重切修复在提取进行时保持禁用，这样我不会因重新切分章节而破坏一个在跑的 DNA 任务。
21. 作为读者，我在提取途中切换面板时，想让后台任务存活，这样进度不丢。
22. 作为读者，我想让失败的提取（`error`）保持可见并附重试入口，而不是被静默自动重启，这样我能理解发生了什么。
23. 作为维护者，我想要这次改动产出一个回归基线（golden vector 套件），这样后续做候选 #2/#3 时若误碰状态机会立刻被发现。

## Implementation Decisions

- **新增一个纯「提取状态」决策模块**（具体文件名由实现者定）。它无任何 React / Dexie / 网络依赖，是状态机解读的单一事实源。它**不引入任何新的持久化字段**——仍读现有的 `Novel.analysisStatus` / `Novel.dnaCard` / `Chapter.mapStatus`。

- **该模块的接口（按高度从高到低）**：
  - `isDnaReady(novel)` → `boolean`：等价 `analysisStatus === 'done' && 存在 dnaCard`。替换 ≥5 处手抄副本（侧栏就绪计数、配方台挑选、workflow 投影、首页就绪计数）。
  - `isExtracting(novel)` → `boolean`：等价 `analysisStatus ∈ {mapping, reducing}`。替换 ≥4 处副本（首页 `dnaPhase`、workflow stage、重切防护）。
  - `canAutoStart(novel)` → `boolean`：状态层判定（`idle` 且无 `dnaCard`）。`useBackgroundExtraction` 现有的「split-OK / 配置清白 / single-flight」附加门保留在调用侧，本判定只负责状态那一截。
  - `dnaPhase(novel)` → `'idle' | 'extracting' | 'ready' | 'error'`（命名可调）：单一阶段投影，供 WorkflowStepper 与首页派生，合并 `page.tsx` 与 `workflow.ts` 现有的两套映射。
  - `planReconcile(novel, chapters)` → `复位计划 | null`：self-heal 的后向一半，纯函数。语义——若 `isExtracting(novel)` 为真（被滞留），返回 `{ nextAnalysisStatus: 'idle', resetChapterIds: 所有 mapStatus==='mapping' 的章节 id }`；否则返回 `null`。
  - `selectResumeTargets(units, chaptersById)` → `待跑的 units`：前向一半，把现有「过滤掉 lead 已 `done`」的逻辑提成纯函数。

- **统一的不变量（PRD 的核心断言）**：`extracting 状态 + 无在跑任务 ⇒ 滞留 ⇒ reconcile 到 idle 且把 mapping 章节退回 pending`。`planReconcile`（决策）与运行器的前向转移现在共用同一组判定式，二者不再能独立漂移。

- **被修改的模块（行为对齐，仅替换解读逻辑）**：
  - 运行器（`dnaEngine`）：前向转移改用共享判定式；把 self-heal 的**落库**收成一个由它导出的薄函数 `reconcileExtraction(novelId)`（读 novel + chapters → 调 `planReconcile` → 在单个 `db.transaction` 内应用复位计划）；`selectResumeTargets` 取代内联的 `targets` 过滤。`withRateLimitRetry` / `RateLimitSignal` / `ensureIncrementalHashes` / size-routing 一律不动。
  - `NovelDetail`：挂载 self-heal 不再内联 `db.novels.update` + `db.chapters.modify`，改为调用运行器导出的 `reconcileExtraction(novelId)`。前向与后向自此同住运行器/模块接口后面。
  - `page.tsx`：`useBackgroundExtraction` 用 `canAutoStart` 取代 `analysisStatus !== 'idle' || dnaCard` 的内联判断；`dnaPhase` 派生改用共享投影。single-flight、面板切换存活、完成 toast 等编排保留。
  - `workflow.ts`：`getNovelWorkflowSummary` 用 `isDnaReady` / `isExtracting` / `dnaPhase` 取代内联字符串比较。stepper 的 UI 文案/标签不变。
  - `NovelUploader`：重切防护改用 `isExtracting`。上传/重切设初始 `idle`、手动拼接/切分把编辑章节置 `mapStatus:'pending'` 这类**内容变更重置**保持原样（语义本地正当，不属本次收编）。
  - `FusionWorkshop`：骨架/题材就绪挑选改用 `isDnaReady`。

- **不做 Dexie `version(n)` 升级**：本次不改任何已落库形状（仍是同样的字段、同样的表），遵守「仅在存储形状变更时升版」这条铁律。

- **不碰**：`api/schemas.py`、任何 LLM 端点与 prompt、size-routing 的阈值（direct/arc/sampling）、arc 窗口预算与采样上限。

## Testing Decisions

- **什么是好测试**：只测纯决策模块的**外部行为**——给定一个 `Novel` + 章节快照，断言它的输出（`dnaPhase`、`isDnaReady`/`isExtracting`/`canAutoStart` 判定、`planReconcile` 的复位计划、`selectResumeTargets` 的待跑集合）。不断言内部辅助函数、不断言 db 调用次数、不窥探实现细节。interface 即测试面。
- **被测模块**：新增的纯「提取状态」决策模块，新增一个 `*.test.ts` 进入现有纯逻辑 Vitest 套件（node 环境，无 React/RTL/jsdom/Dexie）。
- **先例（照抄其形态）**：`dnaRouting.test.ts`（纯路由 + golden vector）、`chapterOps.test.ts`（纯计划，含索引/边界用例）、`settingHistory.test.ts`（纯快照栈）、`splitQuality.test.ts`（golden vector pin 算术）。
- **要 pin 的 golden vector（至少）**：
  - 滞留于 `mapping` 的 novel + 混合 `mapStatus` 章节 → `planReconcile` 返回 `nextAnalysisStatus:'idle'` 且 `resetChapterIds` 恰为 `mapping` 的那些。
  - 滞留于 `reducing` → 同样产出复位计划。
  - 干净的 `done` + 有 `dnaCard` → `planReconcile` 返回 `null`；`isDnaReady` 真；`canAutoStart` 假。
  - `idle` 且无 `dnaCard` → `canAutoStart` 真；`dnaPhase==='idle'`。
  - `error` → `dnaPhase==='error'`；`canAutoStart` 假（不自动重启）；`isExtracting` 假。
  - units 中 lead 已 `done` 与未 `done` 混合 → `selectResumeTargets` 恰好剔除 `done` 的 lead。
- **不做单测的部分**：db 落地层（`reconcileExtraction` 的事务、运行器对 plan 的应用）——遵守现有「pure-logic only」测试决策，靠**手动走查**验证：提取途中刷新 → 确认恢复到 idle、`mapping` 章节回 `pending`、续跑跳过 `done`、最终 `done` 且 `dnaCard` 就位；以及 stepper 与 DNA 板显示一致。

## Out of Scope

- 架构评审里的其余候选：#2 变体漏斗深化、#3 LLM 调用仪式、#4 章节编辑 apply seam、#5 DNA 形状跨语言单源、#6 Ollama 心跳、#7 切分评分单份。
- 对 db 落地层做 Dexie-mock / fake-IndexedDB 集成测试（用户已选「仅纯决策模块 @ 现有 Vitest seam」）。
- 任何对 `Novel` / `Chapter` / `FusionSession` 已落库形状、Dexie 版本、迁移的改动。
- size-routing 行为（direct/arc/sampling 判定、arc 窗口预算、采样上限）的任何调整。
- LLM 端点、`api/schemas.py`、prompt、`withRateLimitRetry` 退避策略的任何改动。
- DNA 板 / WorkflowStepper 的视觉或文案改版——本次只要行为对齐。
- 已废弃的单章 `ChapterAnalysis` / `Character` / `Relationship` 类型。

## Further Notes

- **领域文档**：仓库尚无 `CONTEXT.md` 与 `docs/adr/`（按 `docs/agents/domain.md` 的指引静默继续），本 PRD 沿用 `CLAUDE.md` 的领域词汇。无 ADR 冲突。本深化**尊重**两条既有铁律：「测试只做 pure-logic」与「仅在存储形状变更时升 Dexie 版本」——本 PRD 两者都不触碰。
- **行为对齐是验收线**：这是深化重构而非功能变更。当前的崩溃恢复、续跑、后台自启、stage 显示、就绪挑选行为必须逐一保留，只是收敛到一处。建议实现者在动手前先记下现状行为作为对照基线。
- **顺序建议**：本项落地后，状态机不再泄漏到 UI 层，候选 #2（变体漏斗收成深「创作」模块）与 #3（LLM 调用仪式）会更好推理。
- **领域术语对照**（供实现者）：`骨架 = engine`（结构+节奏，DNA ①②层）、`题材 = skin`（主题+文风，③④层）、`resumable runner = runDnaExtraction`、`self-heal-on-mount = NovelDetail 挂载对账`、`background extraction = useBackgroundExtraction`。

## Comments

> *This was generated by AI during triage.*

**批量 triage（2026-06-04）**：本 PRD 及其 4 个子 issue 经 `/triage` 评定 category=`enhancement`（深化重构=改进，非 bug）。

- 4 个子 issue 各补 `Category: enhancement`，state 维持 `ready-for-agent`（issue body 即完整 agent brief，含验收标准）。
- 本 PRD 原误带 `Status: ready-for-agent`——作为父规格不参与 agent state 机，已改为 `Status: parent-spec`，triage 状态以子 issue 为准。
- category 记录惯例（`Category:` 行）+ parent-spec 约定已补进 `docs/agents/triage-labels.md`。

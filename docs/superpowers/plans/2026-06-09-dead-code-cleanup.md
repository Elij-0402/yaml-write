# 死代码 / 未引用代码清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变任何运行时行为的前提下，移除 `yaml-write/` 前后端死代码（未引用文件/导出/依赖、零读写死类型、不在活路径的后端端点、注释死代码），分 8 批逐批验证并独立提交。

**Architecture:** 这是**删除型重构**，不是新功能开发。因此 TDD 的形态是「现有测试套件作为回归守护」——每批删除前后跑全套验证（前端 `tsc --noEmit` + `npm test` + `npm run build`，后端 `python -m unittest`），保持绿→删→仍绿；编译器与测试是删除安全的客观终审。删除候选用「工具扫描 + agent 对抗性证伪」双保险产生：knip/vulture/grep 三路盲扫取并集（批次 0），每个候选派 skeptic agent 反向举证「它其实是活的」，无法被反驳才删。批次 0 产出 `candidates.md` 清单，是后续所有数据驱动批次的输入契约。

**Tech Stack:** Next.js 14 + TypeScript（前端）、FastAPI + Pydantic（后端）、Dexie/IndexedDB、Vitest、Python unittest、knip（前端死代码扫描）、vulture（Python 死代码扫描）、Workflow 工具（对抗性验证编排）。

**Spec:** `docs/superpowers/specs/2026-06-09-dead-code-cleanup-design.md`

---

## File Structure

本计划触及的文件：

- **新建** `.scratch/dead-code-cleanup/candidates.md` — 批次 0 产出的待删清单（含对抗性验证结论），后续批次的输入契约。
- **修改** `app/db.ts` — 批次 1：删除 `Character`/`Relationship`/`ChapterAnalysis` 接口 + `Chapter.analysis` 字段，新增 `db.version(14)` 迁移。
- **修改** `CLAUDE.md` — 批次 1 / 4a：同步移除已删类型与端点的描述。
- **修改** `package.json` + `package-lock.json` — 批次 3：移除未用依赖。
- **修改** `api/index.py` / `api/schemas.py` — 批次 4a/4b：删除死端点与未引用模型/函数。
- **修改（动态，由 candidates.md 决定）** `app/**` / `components/**` — 批次 2a/2b/2c：删除注释死代码、未引用导出、未引用整文件。

每批是一次自包含、可独立回滚的提交。

---

## 全套验证命令（每批 commit 前必跑，全绿才提交）

所有命令从 `yaml-write/` 目录运行：

```bash
npx tsc --noEmit                                      # 前端类型检查（最快，先跑）
npm test                                              # Vitest 纯逻辑单测（7 套件）
npm run build                                         # Next 完整构建
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security  # 后端 unittest（CLAUDE.md 保证 test_scene_resume 可跑；其余两个若因环境缺依赖跑不起来，至少保证 test_scene_resume 全绿）
```

预期：四项全部 0 退出码、无报错。任一项红 → 回退该批改动，不提交。

---

## Task 0: 检测与清单生成（不删任何代码）

**Files:**
- Create: `.scratch/dead-code-cleanup/candidates.md`

**说明：** 本任务只产出清单文档，不改动任何源码、不提交源码改动。用三路盲扫取并集，再用 Workflow 对每个候选做对抗性验证。

- [ ] **Step 1: 跑 knip 扫描前端（未用文件/导出/依赖）**

Run（从 `yaml-write/`）：

```bash
npx knip --no-progress 2>&1 | tee .scratch/dead-code-cleanup/knip-raw.txt
```

预期：输出分组报告（`Unused files` / `Unused exports` / `Unused dependencies` / `Unused devDependencies`）。
注意：若 knip 报「No entry files found」，在 `yaml-write/knip.json` 写最小配置 `{"entry":["app/layout.tsx","app/page.tsx","public/workers/*.js"],"project":["app/**","components/**"]}` 后重跑（此 `knip.json` 仅供扫描用，批次 3 完成后删除，不留仓库）。knip 默认能识别 Next.js plugin，多数情况零配置即可。

- [ ] **Step 2: 跑 vulture 扫描后端 Python**

Run（从 `yaml-write/`）：

```bash
python -m pip install vulture
python -m vulture api/index.py api/schemas.py --min-confidence 60 2>&1 | tee .scratch/dead-code-cleanup/vulture-raw.txt
```

预期：逐行 `path:line: unused function/variable/import ...`。
**已知误报**：vulture 会把所有 `@app.post(...)` 端点处理函数报成 unused（它们经装饰器注册、无直接调用）。这些**不是**死代码判据——必须靠 Step 3 的端点字符串扫描 + 前端调用核实。

- [ ] **Step 3: 全仓字符串引用扫描（捕捉工具盲区）**

Run（从 `yaml-write/`）：

```bash
# 后端端点：列出所有定义的 /api/py/ 路由，再看前端是否有对应字符串调用
grep -rn '/api/py/' api/index.py
grep -rn '/api/py/' app components --include="*.ts" --include="*.tsx"
```

预期：左边是后端定义的全部端点路径，右边是前端实际调用的端点路径。**出现在后端定义、但前端零调用、且无任何测试引用的端点 = 死端点候选**（如 `extract-chapter-map`）。把差集记下。

- [ ] **Step 4: 用 Workflow 对每个候选做对抗性验证**

调用 Workflow 工具编排（ultracode 已开启，授权使用）。脚本职责：把 Step 1–3 收集的候选项（未用文件、未用导出、未用依赖、死端点、未用 Pydantic 模型/函数）逐项 fan-out，每项派一个 skeptic agent，prompt 要求其**反向举证「该符号其实是活的」**——检查：动态 `import()`/`require`、字符串拼接的端点/路径、Next.js 约定文件（`page`/`layout`/`favicon`）、`public/workers/*.js` 静态 worker 的字符串引用、Dexie `.upgrade()` 内引用、Pydantic/instructor 反射式使用、测试文件引用。schema 返回 `{verdict: 'dead'|'alive', evidence: string}`。任一 skeptic 举证 `alive` → 标 🔒保留并记录其 evidence。

Workflow 脚本骨架（执行时按实际候选数填充 `args`）：

```javascript
export const meta = {
  name: 'dead-code-adversarial-verify',
  description: '对每个死代码候选派 skeptic agent 反向举证它其实是活的',
  phases: [{ title: 'Verify' }],
}
const candidates = args  // [{kind, ref, evidence}] 来自 knip/vulture/grep
const verdicts = await parallel(candidates.map(c => () =>
  agent(
    `在 yaml-write/ 项目中，反向举证以下符号【其实是活代码】：${c.kind} ${c.ref}。` +
    `检查：动态 import/require、字符串拼接的端点或路径、Next.js 约定文件、public/workers/*.js 静态 worker 的字符串引用、` +
    `Dexie .upgrade() 内引用、Pydantic/instructor 反射式使用、测试文件引用。` +
    `若找到任何使其存活的引用，verdict='alive' 并给出 file:line 证据；确实找不到才 verdict='dead'。`,
    { label: `verify:${c.ref}`, phase: 'Verify',
      schema: { type: 'object', required: ['verdict','evidence'],
        properties: { verdict: { enum: ['dead','alive'] }, evidence: { type: 'string' } } } }
  ).then(v => ({ ...c, ...v }))
))
return verdicts.filter(Boolean)
```

- [ ] **Step 5: 汇总写入 candidates.md（固定格式，后续批次的输入契约）**

把 knip/vulture/grep 候选 + 对抗性验证结论合并，写入 `.scratch/dead-code-cleanup/candidates.md`，按批次分组，每条标 ✅可删 / 🔒保留 / ❓需人工核实，附 file:line 与证据。格式样例：

```markdown
# 死代码待删清单（批次 0 产出）

## 批次 2a — 注释掉的死代码块
- [ ] ✅ `app/foo.ts:120-145` 大段注释旧实现 — 证据：纯注释，无激活引用

## 批次 2b — 未引用导出 / 内部死函数
- [ ] ✅ `app/bar.ts:42` export function `baz` — knip 报未用；skeptic verdict=dead
- [ ] 🔒 `app/qux.ts:10` export `quux` — skeptic verdict=alive，证据：public/workers/x.js:88 字符串引用

## 批次 2c — 未引用整文件
- [ ] ✅ `app/orphan.ts` — knip 报未用文件；skeptic verdict=dead

## 批次 3 — 未用依赖
- [ ] ✅ `some-pkg` — knip 报未用依赖；全仓零 import

## 批次 4a — 后端死端点
- [ ] ❓ `extract-chapter-map` (api/index.py:600) — 前端零调用，需确认无测试引用

## 批次 4b — 未引用 Pydantic 模型 / 内部死函数
- [ ] ✅ `api/schemas.py:NN` class `SomeUnusedResponse` — vulture 报未用；无 response_model 引用
```

- [ ] **Step 6: Commit 清单文档**

```bash
git add .scratch/dead-code-cleanup/candidates.md .scratch/dead-code-cleanup/knip-raw.txt .scratch/dead-code-cleanup/vulture-raw.txt
git commit -m "chore(cleanup): 批次0 死代码候选清单与对抗性验证结论"
```

---

## Task 1: 死类型族删除（前端，已知确定项）

**Files:**
- Modify: `app/db.ts`（删除 `Character` 4-10、`Relationship` 12-16、`ChapterAnalysis` 18-24、`Chapter.analysis` 字段 111；新增 `version(14)` 块）
- Modify: `CLAUDE.md`（移除 deprecated `ChapterAnalysis`/`Character`/`Relationship` 描述）

- [ ] **Step 1: 删除三个死接口**

在 `app/db.ts` 删除以下三块（行 4–24），保留行 26 起的注释：

删除：
```typescript
export interface Character {
  name: string;
  personality: string;
  appearance: string;
  coreConflict: string;
  chapters: string;
}

export interface Relationship {
  roleA: string;
  roleB: string;
  description: string;
}

export interface ChapterAnalysis {
  worldview: string;
  plotSkeleton: string;
  characters: Character[];
  relationships: Relationship[];
  style: string;
}
```

- [ ] **Step 2: 删除 Chapter.analysis 字段**

在 `app/db.ts` 的 `Chapter` 接口中删除这一行（原 111 行）：

删除：
```typescript
  analysis?: ChapterAnalysis; // deprecated since v5 — replaced by mapSummary
```

- [ ] **Step 3: 新增 db.version(14) 迁移块**

在 `app/db.ts` 的 `version(13)` 块之后、`constructor` 闭合 `}` 之前（原 382 行 `}` 后），插入：

```typescript
    // v14: 移除废弃的 ChapterAnalysis 类型族——Chapter.analysis 自 v5 起被 mapSummary 取代，全仓零读写。
    // 索引串与 v13 一致（analysis 非索引、纯类型层移除）。存量章节残留的 analysis 主动删除，避免无主数据长存。
    this.version(14)
      .stores({
        novels: 'id, name, createdAt, splitStatus, analysisStatus',
        chapters: 'id, novelId, chapterIndex, status, mapStatus',
        fusionSessions: 'id, updatedAt, createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('chapters').toCollection().modify((c: Record<string, unknown>) => {
          delete c.analysis;
        });
      });
```

（此模式与现有 v11 删除 `settingHistory` 完全一致。）

- [ ] **Step 4: 同步 CLAUDE.md**

在 `CLAUDE.md` 中找到描述 deprecated 类型的句子（约在 "4-layer engine/skin DNA" 节：`The deprecated per-chapter ChapterAnalysis/Character/Relationship types still live in db.ts (kept on Chapter.analysis? for zero data loss) but the backend has no matching model.`），将其改为：

```markdown
The deprecated per-chapter `ChapterAnalysis`/`Character`/`Relationship` types and the `Chapter.analysis?` field were **removed** (Dexie v14 deletes any residual `analysis` from stored chapters); the per-chapter map now lives in `mapSummary`.
```

同时在 Dexie 里程碑列表（`### Local persistence` 节）末尾、v13 之后补一行：

```markdown
- **v14**: removes the deprecated `ChapterAnalysis` type family — drops the `Chapter.analysis?` field and deletes any residual `analysis` from stored chapters. Index strings unchanged.
```

并把该节开头的 `currently at version(13)` 改为 `currently at version(14)`。

- [ ] **Step 5: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
```

预期：四项全绿。`tsc` 尤其会立即报出任何仍引用 `ChapterAnalysis`/`Character`/`Relationship`/`.analysis` 的残留点——应为零（批次 0 已确认零读写）。

- [ ] **Step 6: Commit**

```bash
git add app/db.ts CLAUDE.md
git commit -m "refactor(cleanup): 移除废弃 ChapterAnalysis 类型族 + Dexie v14 迁移"
```

---

## Task 2a: 删除注释掉的死代码块

**Files:**
- Modify:（动态）`candidates.md` 「批次 2a」分组中标 ✅ 的 file:line

- [ ] **Step 1: 读取清单**

打开 `.scratch/dead-code-cleanup/candidates.md`，定位「批次 2a — 注释掉的死代码块」分组，取所有标 ✅ 的条目。

- [ ] **Step 2: 逐条删除注释死代码**

对每个 ✅ 条目，按其 `file:line` 删除对应的整段注释代码。只删被注释掉的旧实现，保留解释性注释（说明「为什么」的注释保留，「被注释掉的旧代码」删除）。

- [ ] **Step 3: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
```

预期：四项全绿（删注释不应影响任何编译/测试）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(cleanup): 删除注释掉的死代码块（批次2a）"
```

---

## Task 2b: 删除未引用的导出符号 / 内部死函数

**Files:**
- Modify:（动态）`candidates.md` 「批次 2b」分组中标 ✅ 的 file:line

- [ ] **Step 1: 读取清单**

打开 `.scratch/dead-code-cleanup/candidates.md`，定位「批次 2b — 未引用导出 / 内部死函数」分组，取所有标 ✅（skeptic verdict=dead）的条目。跳过所有 🔒。

- [ ] **Step 2: 逐条删除符号**

对每个 ✅ 条目，删除该导出符号（函数/类型/常量）或内部死函数的完整定义。删除后顺带删除该符号在文件内已不再需要的 import（若有）。

- [ ] **Step 3: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
```

预期：四项全绿。`tsc` 会立即报出误删（若某符号其实被引用，编译报错 → 回退该条并在 candidates.md 改标 🔒）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(cleanup): 删除未引用的导出符号与内部死函数（批次2b）"
```

---

## Task 2c: 删除未引用的整文件

**Files:**
- Delete:（动态）`candidates.md` 「批次 2c」分组中标 ✅ 的文件

- [ ] **Step 1: 读取清单并二次核实**

打开 `.scratch/dead-code-cleanup/candidates.md`，定位「批次 2c — 未引用整文件」分组，取标 ✅ 的文件。**删整文件影响面最大**——删除前对每个文件再跑一次确认：

```bash
# 把 <basename> 换成不含扩展名的文件名，确认全仓（含 worker 静态文件）零引用
grep -rn "<basename>" app components public api --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py"
```

预期：仅命中文件自身定义处，无任何外部 import / 字符串引用。若命中外部引用 → 改标 🔒，跳过。

- [ ] **Step 2: 删除文件**

对确认无引用的每个文件：

```bash
git rm <path>
```

- [ ] **Step 3: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
```

预期：四项全绿。

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(cleanup): 删除未引用的整文件（批次2c）"
```

---

## Task 3: 删除未用依赖

**Files:**
- Modify: `package.json`、`package-lock.json`
- Delete:（若批次 0 创建过）`knip.json`

- [ ] **Step 1: 读取清单**

打开 `.scratch/dead-code-cleanup/candidates.md`，定位「批次 3 — 未用依赖」分组，取标 ✅ 的包名。对每个包再确认一次全仓零 import：

```bash
grep -rn "from ['\"]<pkg>['\"]\|require(['\"]<pkg>['\"]" app components api
```

预期：零命中（确认未被运行时使用）。注意构建/配置类依赖（如 `autoprefixer`/`postcss`/`tailwindcss`/`eslint-config-next`）可能只在配置文件被用、不在源码 import——这类应已被 knip 的 Next/PostCSS 插件识别为「已用」；若 knip 仍报它们未用，标 🔒（配置消费）勿删。

- [ ] **Step 2: 移除依赖**

对每个确认 ✅ 的包：

```bash
npm uninstall <pkg>
```

（`npm uninstall` 会同时更新 `package.json` 与 `package-lock.json`。）

- [ ] **Step 3: 若批次 0 建过 knip.json，删除它**

```bash
[ -f knip.json ] && git rm knip.json || echo "无 knip.json，跳过"
```

- [ ] **Step 4: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
```

预期：四项全绿。`npm run build` 会暴露任何被错删的构建期依赖。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(cleanup): 移除未用依赖（批次3）"
```

---

## Task 4a: 删除后端死端点

**Files:**
- Modify: `api/index.py`（删除死端点处理函数）
- Modify: `api/schemas.py`（删除仅该端点使用的 response_model，若有）
- Modify: `CLAUDE.md`（端点表移除对应行）

- [ ] **Step 1: 读取清单并终审死端点**

打开 `.scratch/dead-code-cleanup/candidates.md`「批次 4a」分组。对每个候选端点（如 `extract-chapter-map`）做最终确认：

```bash
# 确认前端零调用、测试零引用
grep -rn "extract-chapter-map" app components api --include="*.ts" --include="*.tsx" --include="*.py" | grep -v "@app.post\|def extract"
```

预期：仅命中后端定义自身（装饰器 + 函数定义）。若命中任何前端/测试调用 → 标 🔒，跳过。

- [ ] **Step 2: 删除端点处理函数**

在 `api/index.py` 删除确认为死的端点的 `@app.post("/api/py/<name>")` 装饰器 + 其处理函数完整定义。若该端点在 `RATE_LIMIT_RULES` 里有专属限流条目，一并删除该条目。

- [ ] **Step 3: 删除仅该端点使用的 response_model**

检查被删端点的 `response_model`（如 `ChapterMapSummaryResponse`）是否仍被其他端点使用：

```bash
grep -rn "ChapterMapSummaryResponse" api/index.py api/schemas.py
```

若仍被其他端点引用（如 `extract-arc-map` 也用它）→ **保留** `schemas.py` 中的定义，只删 import 中已不需要的部分；若已无任何端点引用 → 从 `api/schemas.py` 删除该 Pydantic 类，并从 `api/index.py` 的 import 移除。
**铁律提醒**：`api/schemas.py` ↔ `app/dnaSchema.ts` 字段对齐——若删除的模型在前端 `dnaSchema.ts` 有对应 parse 函数且前端已不用，记为批次 2b 的 candidates 复查项（不在本批顺手删，保持批次边界）。

- [ ] **Step 4: 同步 CLAUDE.md 端点表**

在 `CLAUDE.md` 的「LLM endpoints」表中删除被删端点对应的整行，并把表上方的端点计数（`**9** /api/py/ routes`）相应减 1。若描述段提到该端点（如 `extract-chapter-map still exists for single-chapter mapping`），删除该句。

- [ ] **Step 5: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
```

预期：四项全绿。后端 unittest 会暴露任何对已删端点/模型的引用。额外冒烟：

```bash
python -c "import api.index"
```

预期：导入成功、无 `ImportError`/`NameError`。

- [ ] **Step 6: Commit**

```bash
git add api/index.py api/schemas.py CLAUDE.md
git commit -m "refactor(cleanup): 删除后端死端点及其专属模型（批次4a）"
```

---

## Task 4b: 删除未引用的 Pydantic 模型 / 内部死函数（后端）

**Files:**
- Modify: `api/index.py`、`api/schemas.py`（动态，由 candidates.md 决定）

- [ ] **Step 1: 读取清单**

打开 `.scratch/dead-code-cleanup/candidates.md`「批次 4b」分组，取标 ✅ 的项。对每个 Pydantic 模型确认无 `response_model=` / 类型注解 / import 引用：

```bash
grep -rn "<ClassName>" api --include="*.py" | grep -v __pycache__
```

预期：仅命中定义自身。**注意**：vulture 对装饰器注册的端点函数误报——本批只删确认无任何引用的 Pydantic 类与纯内部辅助函数，不删任何 `@app.*` 端点函数（端点归批次 4a 处理）。

- [ ] **Step 2: 删除确认的死模型/死函数**

对每个 ✅ 项删除完整定义，并移除对应 import。

- [ ] **Step 3: 全套验证**

Run（从 `yaml-write/`）：

```bash
python -m unittest api.test_scene_resume api.test_generation_modes api.test_security
python -c "import api.index"
```

预期：四项全绿 + `import api.index` 成功。

- [ ] **Step 4: 清理临时扫描产物并 Commit**

```bash
git rm .scratch/dead-code-cleanup/knip-raw.txt .scratch/dead-code-cleanup/vulture-raw.txt 2>/dev/null || true
git add -A
git commit -m "refactor(cleanup): 删除未引用的后端模型与内部死函数（批次4b）"
```

---

## 完成标准

- 8 批全部独立提交，每批 commit 前全套验证四项全绿。
- `candidates.md` 中每个候选都有终态（✅已删 / 🔒保留含理由）。
- 无运行时行为变化：手动冒烟一遍核心流（上传 → 拆章 → DNA 提取 → 工坊融合 → 流式开篇），确认与清理前一致。
- CLAUDE.md 与代码一致（类型族描述、Dexie 版本号、端点表均已同步）。
- Legacy DNA 卡族原样保留（留给后续 UI/UX 重构 spec）。

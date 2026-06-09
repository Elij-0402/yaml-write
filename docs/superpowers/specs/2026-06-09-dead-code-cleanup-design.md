# 死代码 / 未引用代码清理 — 设计文档

- 日期：2026-06-09
- 范围：本次只做「死代码清理」。前端 UI/UX 重构走**独立**的后续 spec（先清理、后重构，让重构站在干净代码上）。
- 项目：`yaml-write/`（Next.js 14 + FastAPI，中文小说「换皮变题」工具）

## 1. 目标

在**不改变任何运行时行为**的前提下，移除前后端死代码：未引用的文件 / 导出 / 依赖、已确认零读写的死类型、不在活路径的后端端点、注释掉的旧代码。

成功标准：

- 所有删除均通过客观裁判：`npx tsc --noEmit` + `npm test` + `npm run build`（前端）、`python -m unittest`（后端）全绿。
- 没有可观察的行为变化（UI / 流式 / 提取 / 持久化 不变）。
- 每批删除可独立回滚。
- CLAUDE.md 与代码保持一致。

## 2. 安全边界

### 必须守住的铁律（继承自 CLAUDE.md）

- `app/dnaSchema.ts` ↔ `api/schemas.py` 字段逐一 camelCase 对齐。
- `app/splitRegex.ts` / `app/splitQuality.ts` 与 `public/workers/novel-parser-worker.js` 内联副本**字节等价**（golden-vector 测试守护）。
- 任何存储形状变更都要**新开** `db.version(n)` 块，不可改动既有版本定义。
- 后端硬化（限流 / SSRF 守卫 / API-key 脱敏 / 友好错误）一律不动。
- keys 永不落服务端存储。

### 本次处理边界

| 处理 | 对象 | 依据 |
|---|---|---|
| ✅ 删除 | 死类型族：`ChapterAnalysis`、`Character`、`Relationship` 接口 + `Chapter.analysis` 字段 | 全仓零读写（`grep` 仅命中 `analysisStatus`，无人读 `chapter.analysis`） |
| ✅ 删除 | knip 扫出并经对抗性验证核实的未引用文件 / 导出 / 依赖 | 见 §4 方法论 |
| ✅ 删除 | vulture 扫出并核实的后端死端点 / 模型 / 函数 | 见 §4 方法论 |
| ✅ 删除 | 注释掉的大块旧代码 | 纯文本，零风险 |
| 🔒 保留 | Legacy DNA 卡族（`LegacyNovelDNACard` / `isLegacyDnaCard` / `isFourLayerDnaCard` / `dnaCardVersion`） | 仍被 `NovelDetail` / `FusionWorkshop` 活路径渲染；其去留留给后续 UI/UX 重构 spec 处理 |
| 🔒 保留 | `app/workflow.ts` 的 `getLlmReadinessSummary` | 被 `app/page.tsx` 与 `components/NovelDetail.tsx` 调用 |
| 🔒 保留 | 后端硬化逻辑、worker 双拷贝、Dexie 既有版本块 | 铁律 |

## 3. 清理批次（8 批，逐批验证 + 独立提交）

风险同质不拆，风险面不同的拆开。顺序按风险从低到高。

### 批次 0 — 检测与清单生成（不删任何代码）

- `npx knip`（前端：未用文件 / 导出 / 依赖，不加入依赖，一次性）。
- `pip install vulture && vulture api/`（后端 Python 死代码）。
- 全仓 `grep` 字符串引用扫描（捕捉工具盲区：动态 `fetch` 路径、`@app.post("...")` 端点串）。
- 三路结果 + 已知确认项合并成「待删清单」，逐条标 ✅可删 / 🔒保留 / ❓需人工核实，附对抗性验证结论。
- 产出物：清单文档（写入 `.scratch/dead-code-cleanup/` 或本 spec 附录）。**只产文档，不改代码、不提交代码。**

### 批次 1 — 死类型族（前端，零运行时影响）

- 删 `app/db.ts` 的 `ChapterAnalysis`、`Character`、`Relationship` 接口 + `Chapter.analysis` 字段。
- 新开 `db.version(14)`：`.upgrade()` 删除存量记录里残留的 `analysis` 字段（零数据丢失——本就无人读）。
- 同步更新 CLAUDE.md 中描述这些 deprecated 类型的段落。

### 批次 2a — 注释掉的死代码块

- 清除 `app/` / `components/` 里大段注释掉的旧代码。纯文本删除，零风险，先做。

### 批次 2b — 未引用的导出符号 / 内部死函数

- 按经核实的清单删除未引用的导出符号（类型 / 常量 / 函数）与内部死函数。tsc 立即兜底。

### 批次 2c — 未引用的整文件

- 若 §0 扫出整文件未引用，单独提交（影响面最大、最易藏动态引用，删前再次对抗性核实 Next 约定文件 / worker 静态文件）。

### 批次 3 — 未用依赖（前端）

- 按经核实的清单从 `package.json` 移除确认未 import 的依赖，刷新 `package-lock.json`。

### 批次 4a — 后端死端点

- 删除经核实确为死的端点（如 `extract-chapter-map`，`api/index.py:600` 附近，前端零调用，CLAUDE.md 称"retained 供单章映射"——**批次 0 重点核实**：grep 全仓 + 确认无前端/测试引用，核实为真死才删，否则标 🔒保留）。
- 同步删 CLAUDE.md 端点表对应行 + `api/schemas.py` 对应 `response_model`（注意 dnaSchema ↔ schemas.py 对齐铁律）。

### 批次 4b — 未引用 Pydantic 模型 / 内部死函数（后端）

- 按经核实的清单删除未引用的 Pydantic 模型与内部死函数。

## 4. 方法论：对抗性验证的删除判定

死代码清理唯一的真实风险是**误判**。工具盲点：

- 动态 / 字符串引用（后端 `@app.post("/api/py/...")`、前端 `fetch` 字符串拼接）。
- Next.js 约定文件（`page.tsx` / `layout.tsx` / `favicon`）、`public/workers/*.js`（不在 webpack 图里的静态 worker）。
- Dexie `.upgrade()` 迁移、Pydantic / instructor 的反射式使用。
- 测试文件对被测模块的引用。

**原则：不信任任何单一来源 —— 工具给候选，agent 对抗性证伪，编译器/测试做终审。** 实现阶段用 Workflow 编排，而非顺序手删：

1. **多模态扫描 fan-out** — knip / vulture / 全仓 grep 三路并行盲扫，候选取并集，互补盲区。
2. **对抗性删除判定** — 每个候选删除项派独立 skeptic agent，任务是反向举证"它其实是活的"（找任何动态/字符串/约定引用）。无法被反驳才进删除清单；任一 agent 举证成功 → 标 🔒保留并记录理由。
3. **客观 ground truth 兜底** — 每批删除后跑前端 `tsc --noEmit` + `test` + `build` / 后端 `unittest`。编译器与测试是最终裁判；任一项红 → 该批回退。
4. **无静默截断** — 凡标"保留"或"存疑"的项都 `log` 出理由，清单可审计。

## 5. 验证、提交与回滚

- **每批**：删除 → 全套验证（前端 `tsc --noEmit` + `npm test` + `npm run build`，后端 `python -m unittest`）→ 全绿才 `git commit`，提交信息写明批次与依据。
- **回滚**：任一批验证失败，`git reset` 该批即可，前面批次不受影响。
- **CLAUDE.md 同步**：涉及形状 / 端点 / 架构描述变化的批次（1、4a），在同一提交里更新 CLAUDE.md。
- **交付物**：批次 0 的「待删清单（含对抗性验证结论）」留档。

## 6. 不在本次范围

- 前端 UI/UX 重构（Linear 风格工作心流）—— 独立后续 spec。
- Legacy DNA 卡族的移除 —— 留给 UI/UX 重构 spec。
- 任何行为/功能变更、性能优化、依赖升级。

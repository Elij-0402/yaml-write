# 死代码待删清单（批次 0 产出）

> 扫描工具：knip（前端，已联网跑通）+ vulture --min-confidence 60（后端）+ 全仓 grep（字符串引用/对抗性核实）。
> 原始输出见同目录 `knip-raw.txt` / `vulture-raw.txt`。
> 核实方法：对每个工具命中的候选 grep 全仓（含 `*.test.ts`、`public/workers/*.js`、`api/`），区分「真死（零引用）」与「同文件使用/框架注册式误报」。

## 总览结论

**这个仓库已经过多轮重构、非常干净。真正可删的死代码极少：**
- 批次 1：死类型族 `Character`/`Relationship`/`ChapterAnalysis` + `Chapter.analysis` 字段（3 接口 + 1 字段）。
- 批次 2b：`DnaProgressListener` 一个类型（全仓零引用）。
- 批次 4b：`raise_friendly_api_error` 一个后端函数（全 api 零调用，实现时读函数体终核）。
- 批次 2a / 2c / 3 / 4a：**无真候选**（命中全为误报或有意保留）。

---

## 批次 1 — 死类型族（独立 Task 1 处理，此处仅记录核实结论）
- [x] ✅ `app/db.ts:4` interface `Character` — knip 报未用类型；全仓仅 `ChapterAnalysis` 内部引用
- [x] ✅ `app/db.ts:12` interface `Relationship` — 同上
- [x] ✅ `app/db.ts:18` interface `ChapterAnalysis` — knip 报未用类型；仅被 `Chapter.analysis` 字段引用
- [x] ✅ `app/db.ts:111` field `Chapter.analysis?` — 全仓零读写（grep `.analysis` 仅命中 `analysisStatus`）

## 批次 2a — 注释掉的死代码块
（无候选）启发式扫描「行首 // 紧跟代码 token」零命中；所有 `/* */` 均为有意义的迁移说明 / JSX 区块标记 / catch 忽略说明。

## 批次 2b — 未引用导出 / 内部死函数
- [ ] ✅ `app/dnaEngine.ts:19` type `DnaProgressListener` — 全仓仅定义行，零引用 → 真死，删整行
- [ ] 🔒 `app/dnaEngine.ts:193` `ensureIncrementalHashes` — 同文件 dnaEngine.ts:268 调用，非死代码（export 多余但保留）
- [ ] 🔒 `app/dnaSchema.ts:70` `parseStructureBeat` — 同文件 dnaSchema.ts:81 调用
- [ ] 🔒 `app/llmClient.ts:20` `getActiveLlmRuntimeConfig` — 同文件 :34/:66 调用，且 CLAUDE.md 列为 llmClient 公共 API
- [ ] 🔒 `app/llmClient.ts:62` `withLlmPayload` — 同文件 :98 调用，CLAUDE.md 列为公共 API
- [ ] 🔒 `app/llmClient.ts:4` interface `ActiveLlmRuntimeConfig` — `getActiveLlmRuntimeConfig` 返回类型，活
- [ ] 🔒 `app/llmProviders.ts:26` `PROVIDER_REGISTRY` — 同文件 :107/:111/:116 调用，CLAUDE.md 记录的 registry
- [ ] 🔒 `app/llmProviders.ts:9` interface `ProviderModelPreset` — 同文件 :21 使用
- [ ] 🔒 `app/splitQuality.ts:14` `SHORT_CHAPTER_CHAR_LIMIT` — 同文件 :99 使用（splitQuality 与 worker 副本字节等价铁律，勿动）
- [ ] 🔒 `app/splitQuality.ts:39` `parseChineseNumber` — 同文件 :62 使用（worker 铁律）
- [ ] 🔒 `app/splitRegex.ts:7` `MAX_CUSTOM_REGEX_LENGTH` — 同文件 :31 使用（worker 铁律）
- [ ] 🔒 `app/splitRegex.ts:18` `hasNestedQuantifierRisk` — 同文件 :35 使用（worker 铁律）
- [ ] 🔒 `app/chapterOps.ts:13` interface `ReindexEntry` — 同文件 :22/:45/:80 使用

> 说明：上述 🔒 项 knip 报「unused export」仅表示「无其他文件 import」，但它们都在**同文件内部使用**——属「export 修饰多余」而非死代码。收紧为非 export 是纯风格优化（零功能收益、且多为 CLAUDE.md 记录的有意 API 表面），按保守边界**不在本次清理**。

## 批次 2c — 未引用整文件
- [ ] 🔒 `public/workers/novel-parser-worker.js` — 经典 Web Worker 静态文件，不在 webpack 图；`app/novelParser.ts` 通过 `new Worker('/workers/novel-parser-worker.js')` 字符串引用。knip 误报。
- [ ] 🔒 `public/workers/jschardet.min.js` — 被 `novel-parser-worker.js:4` `importScripts('jschardet.min.js')` 引用。knip 误报。
（无真候选）

## 批次 3 — 未用依赖
- [ ] 🔒 `jschardet`（package.json:36）— TS 源码零 import；worker 用的是 `public/workers/jschardet.min.js` 静态副本。**可选清理项**：移除 npm 依赖在运行时安全，但会切断 worker 脚本的版本追溯/重新生成路径，按保守边界保留（留待用户定夺）。
- 注：`python`「unlisted binary」是 npm scripts 调用解释器，非依赖问题，忽略。
- 注：`autoprefixer`/`postcss`/`tailwindcss`/`eslint-config-next` 等构建期依赖 knip 未报未用（其 Next/PostCSS 插件正确识别），无需处理。
（无真候选）

## 批次 4a — 后端死端点
（无候选）后端定义 8 个 `/api/py/` 端点（extract-arc-map / extract-book-direct / extract-book-reduce / generate-fusion-directions / repair-setting-gaps / split-recommend / stream-scene-text / tweak-fusion-blocks），与前端调用字符串**完全一致**。**CLAUDE.md 提到的 `extract-chapter-map` 端点实际已不存在**（早被删除，文档未同步）——CLAUDE.md 需在批次 4a/收尾时校正。

## 批次 4b — 未引用 Pydantic 模型 / 内部死函数
- [ ] ✅ `api/index.py:281` function `raise_friendly_api_error` — 全 api 目录仅定义行，零调用 → 真死。**实现时先读函数体确认无装饰器/副作用注册再删。**
- [ ] 🔒 `api/index.py:494/499/507` `api_error_handler`/`validation_error_handler`/`unhandled_error_handler` — `@app.exception_handler(...)` 注册式，vulture 误报，活
- [ ] 🔒 `api/index.py` 8 个端点处理函数（extract_book_reduce 等）— `@app.post(...)` 注册式，vulture 误报，活
- [ ] 🔒 `api/schemas.py:76-238` 所有「unused variable」（concept/catalyst/transferNote/directions/beat/issue/patch/gaps/modifiedBlocks/splitParagraphIndex/suggestedTitle/reason/recommendations）— 全是 Pydantic BaseModel 字段声明，被 instructor 序列化、与 dnaSchema.ts 对齐，vulture 误报，活

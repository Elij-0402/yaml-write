# 创作DNA工坊 · 引擎与链路实现蓝图(B)

> 对账依据:已逐文件核对 `yaml-write/` 真实代码(2026-06,Dexie v8 / STORE_VERSION 3)。所有 file:line 均已核验。
> 配套:产品蓝图见对话 + 视觉原型 `docs/redesign-mockup.html`。本文件只管 **UI 之外的引擎与链路**。

---

## 0. 先说结论:什么已就绪 / 什么要改 / 什么是全新

| | 子系统 | 现状 | B 工作量 |
|---|---|---|---|
| ✅ 已就绪 | 断点续传 / 挂载自愈 / 429 退避护航 / persist 失败提示 / 按创作持久化(v8)/ SSE 流式 | `dnaEngine.ts` `withRateLimitRetry`、`store.ts` `onRehydrateStorage`+`decryptKey`兜底、`db.ts` v8、`llmClient.ts` `streamSse` | **几乎不动**,保留 |
| 🔧 改造 | DNA 提取(逐章 map-reduce + 100/全量 + 档位) | `dnaEngine.ts` `runDnaExtraction` + `api/index.py` reduce | 改成**按体量自适应路由** |
| 🔧 改造 | DNA 卡(5 维糊在一起) | `NovelDNACardResponse`(schemas.py:28)/ `NovelDNACard`(db.ts:33) | 重切**4 层(引擎/皮)**,引擎层结构化 |
| 🔧 改造 | 方向生成(融合圆桌 + fusionBias) | `generate-fusion-directions`(index.py:468) | 改成**换皮迁移(角色制)** |
| 🆕 全新 | **补洞**(gap-repair) | 不存在 | 新增一步/端点 |
| 🆕 全新 | diff / 版本历史 数据模型 | 不存在(tweak 直接覆盖) | `FusionSession` 加版本 + 新 Dexie 版本 |
| 🆕 全新 | ✨意图增强(meta-prompt 带确认) | 不存在 | 新增轻量端点 |
| 🗑 删除 | 档位 / fusionBias / temperature UI / early-reduce 耦合 | `store.ts` L81-96,241-243 | 删字段(后端 temperature 保留默认) |

**一句话:B 的重心是"引擎"——水管早就铺好了。**

---

## 1. 子系统:按体量自适应的 DNA 提取

**现状(已核验):** `runDnaExtraction`(dnaEngine.ts:168)对所有书走同一路:逐章 `extract-chapter-map` → `extract-book-reduce`。`limit` 切前 N 章(L178);并发由 `sequencingGear` 档位决定(L227-232);单章 >30000 字直接报错挡住(L190、L195-197);reduce 把 map 摘要折叠(L346-375)。后端 `MAX_REDUCE_INPUT_CHARS=200000`(index.py:54)。

**改造为三档路由(用户零参数,自动判定):**

```
总净化字数(novel.wordCount / sourceTextCleaned.length)
  ├ 小 ≲ 18 万字   → 【单次长上下文】新端点 extract-book-direct:整本喂入 → 直接产 4 层 DNA(跳过逐章 map)
  ├ 中 18万–200万  → 【按弧层级】按「卷/N 章窗口」分组 → 复用现有 worker 池逐组 map → reduce(4 层)
  └ 大 ≳ 200万/上千章 → 【饱和采样】开篇+均匀抽样+尾段 → map → reduce → 收敛检测(卡片 diff 低于阈值即停)
```

- **路由落点**:`runDnaExtraction` 开头加 `routeBySize(novel)`;小档直接调新端点,中/大档复用现有 worker 池(L222-305 的并发/abort/退避机制**原样复用**,只改 `targets` 的选取来源)。
- **并发**:删 `sequencingGear` 依赖,内部固定 `balanced=3`(或按档自动:小档 1、中档 3、大档 6)。
- **单章 30000 字上限**:小档/中档用整本或弧文本,需提高后端 `MAX_CHAPTER_CONTENT_CHARS` 或新增弧级端点(见下)。
- **饱和采样收敛**:每加一批样本后,新旧 4 层卡做字符级/语义相似度比较,低于阈值则停止(避免无意义跑完上千章)。

**后端(api/index.py):**
- 新增 `POST /api/py/extract-book-direct`:输入整本(或大块)文本 → `run_structured` 产 `NovelDNACardResponse`(v2 四层)。注意 `REQUEST_TIMEOUT_SECONDS=25`(L50)对长上下文可能不够,需调高。
- 中/大档:可复用 `extract-chapter-map`(但喂"弧文本"需放宽 30000 上限),或新增 `extract-arc-map`。
- 改 `extract-book-reduce` 的 prompt(L449-457)→ 产出 **4 层**(见 §2),而非现在的 5 维。
- `RATE_LIMIT_RULES`(L57-66)增补新端点条目。

> ⚠️ **Vercel 10s**:单次长上下文 / reduce / 换皮 / 补洞都是大块非流式结构化调用,**必然超 10s**(CLAUDE.md 已警告 reduce 会超)。**决策见 §6-A。**

---

## 2. 子系统:DNA 卡重切为 4 层(引擎/皮)

**现状(已核验):** 5 个自由文本字段,引擎与皮糊在一起——
`NovelDNACardResponse`(schemas.py:28-34)= `theme / worldview / characters / narrativeStyle / styleFingerprint`;TS 侧 `NovelDNACard`(db.ts:33-39)逐字段镜像;被 `generate-fusion-directions` 的 `DNACardItem`(schemas.py:69-75)、`NovelDetail` 的五维卡、reduce prompt 共同引用。**改它=跨 schemas.py / db.ts / FusionWorkshop.tsx / NovelDetail.tsx 同步**(CLAUDE.md「双侧 schema 必须逐字段同步」铁律)。

**新 4 层形状(引擎层结构化、皮层自由文本):**

```python
# schemas.py — NovelDNACardResponse v2
class StructureBeat(BaseModel):       # ① 结构骨架 = Propp 功能序列(结构化、可迁移)
    function: str   # 功能/角色(如「废柴受辱」「获金手指」「打脸」)
    summary: str    # 该节拍在原书的具体体现(一句)
class NovelDNACardResponse(BaseModel):
    structureSkeleton: List[StructureBeat]   # ① 引擎·结构(typed)
    pacingSyuzhet: str                       # ② 引擎·编排节奏(爽点曲线/视角/铺陈)
    themeSkin: str                           # ③ 皮·题材世界观意象(自由文本)
    proseStyle: str                          # ④ 文笔(自由文本;换皮时默认重生成)
```

- **db.ts**:`NovelDNACard` 改同形;**新增 `this.version(9)`**(铁律:形状变更必开新版本块,勿改旧块)。`novels`/`chapters` 索引串与 v8 一致(dnaCard 非索引)。
- **迁移策略(存量 5 维卡)**:无法干净自动转成引擎/皮 → `upgrade` 里把旧 `dnaCard` 标记为 `legacy`(保留原文不丢),`analysisStatus` 维持 `done` 但打一个 `dnaCardVersion:1` 标;**重新提取时才升到 4 层**。(决策见 §6-B。)
- **map 阶段**:`ChapterMapSummary`(4 字段)**可不改**——让更聪明的 reduce prompt 去做引擎/皮的合成,降低改动面。
- **reduce / direct prompt**:重写为"分别提炼可迁移引擎(结构节拍 + 编排)与可替换皮(题材 + 文笔)",输出 4 层。

---

## 3. 子系统:换皮迁移 + 补洞(核心 IP,大部分全新)

**现状(已核验):** `generate-fusion-directions`(index.py:468-518)是"三编剧圆桌"巨型 prompt,吃 `dnaCards[]` + `fusionBias`(2 本时 L504-509),产 3 个 `FusionDirection`(7 字段:title/concept/catalyst/worldviewBlock/protagonistBlock/antagonistBlock/narrativeTone,schemas.py:55-62)。**没有任何"结构迁移"或"补洞"。**

**改造:把"融合"换成"换皮迁移(角色制)"。**
- **输入改造**(schemas.py `FusionDirectionsInput`,L78-86):
  - 删 `fusionBias`;新增 `engineCard`(骨架书的 ①②层)+ `skinSource`(题材书的 ③④层 **或** 单本模式下用户口述的"想要什么"文本)。
- **prompt 改造**:从"圆桌碰撞"→ **显式类推迁移**——把 `engineCard.structureSkeleton` 的每个功能节拍,**逐一映射**到 `skinSource` 的新题材域,产 3 个不同嫁接法的方向。保留 `ANTI_SLOP_CONSTRAINT`(L69)始终注入。
- **🆕 补洞(gap-repair)——质量护城河:** 新增 `POST /api/py/repair-setting-gaps`(或作为"选定方向 → 展开设定"的一个内部 stage):
  - 输入:选定方向的具体新书设定 + 原结构骨架。
  - 任务:逐节拍核对"新题材能否支撑该结构节拍",**定位断裂点**(如"吞噬异火升级"映射到美食后无对应机制),**补入**让逻辑自洽的事件/设定。
  - 依据:Riedl「story analogues」——朴素迁移不保证自洽,必须 plan-repair。

**设定台编辑什么?(重要 reconciliation,决策见 §6-C):**
推荐:设定台编辑 **换皮后新书的具体设定**(沿用现有 `worldviewBlock/protagonistBlock/antagonistBlock/narrativeTone` 4 块,**改动面最小**),每块加一条**只读「引擎来源/题材来源」溯源标**呈现 §1 原型里的引擎/皮材质二元;原始 4 层 DNA 留在"书详情",作为迁移输入。**不**让设定台直接编辑抽象 4 层。

---

## 4. 子系统:diff / 版本历史 / ✨意图增强(共创地基,全新数据)

**现状(已核验):** `tweak-fusion-blocks`(index.py:521-563)按 `targetBlock` 重写并返回新文本;前端**直接覆盖 + 青色脉冲**(无 diff、无版本、命不中静默清空)。`FusionSession`(db.ts:131-147)存 `blocks` 但**无编辑历史**。

**改造:**
- **diff**:后端 tweak **已返回新文本**;diff 在前端用"旧块 vs 新块"算出 → 渲染绿增红删 → 接受/拒绝。后端基本不动,只需保证返回干净的新块文本。
- **🆕 版本历史**(数据模型,B):`FusionSession` 新增 `settingHistory: Array<{blocks, at, note}>`(每次接受 AI 改动前快照)→ **新 Dexie 版本(随 §2 的 v9 合并或单列 v10)**。一键回退 = 取历史项写回。
- **🆕 ✨意图增强**:新增 `POST /api/py/enhance-instruction`——输入用户糙指令 → 返回"精确创作简报 + 我理解你要…"供前端**先确认再执行**(meta-prompt 带确认门;研究警告:不带约束/不展示意图的 meta-prompt 只产泛化结果)。或在 tweak 加 `interpretOnly:true` 干跑标志复用。
- **正文轻量共创**:`stream-scene-text`(index.py:679)可复用——选中句改写 = 把选中片段作为 `currentDraft`/指令传入,流式回改写,前端做接受/拒绝。无整篇 diff。

---

## 5. 子系统:后台化 / store 清理 / 删除项

**后台提取 + 通知:** 现 `NovelDetail` 前台驱动提取(双螺旋盯着等)。改:导入后**自动**在后台起提取(runner 已可续传/abort),用户可走开;全局一个极简进度 + "DNA 就绪"通知。**runner 逻辑保留**,删前台双螺旋板(动画方案 1)。

**store.ts 清理(L75-101,241-243):**
- 删 `sequencingGear`/`setSequencingGear`(L81-82,206)、`shouldReduceEarly` 对外耦合(L83-84,改内部)、`fusionBias`/`setFusionBias`(L95-96,241-242)。
- `temperature` **保留字段**(后端每请求都要,schemas 各 Input 有 `temperature`)但**删 UI 滑块**,固定默认 0.7(或按步内部设)。
- 新增:`engineNovelId`/`skinNovelId`(配方台角色指认)、设定版本相关瞬态。
- `STORE_VERSION` 3 → 4;`migrate`(L265-283)丢弃已删字段。

**保留不动(已就绪):** `withRateLimitRetry` 护航、`onRehydrateStorage`/`persistError`、`decryptKey` 损坏兜底、自愈挂载、SSE/streamSse、splitQuality 切分引擎与 worker(切分照常工作,只是 UI 转"出问题才提示")。

---

## 6. 待你拍板的 3 个真决策

**A. Vercel 10s 部署约束** — 新的重步骤(整本直提、reduce、换皮、补洞)必然超 10s 无服务器上限。
  推荐:**heavy 步骤面向"本地 FastAPI / 非 Vercel 部署"**(`npm run dev` 无超时),或后续改 SSE 流式化。先按"本地/长超时后端"设计,不为 Vercel 阉割质量。

**B. 存量 5 维 DNA 卡迁移** — 旧卡无法干净拆成引擎/皮。
  推荐:**标记 legacy + 保留原文不丢,重新提取时才升 4 层**(便宜、诚实);不做一次性 LLM 重派生(贵、需联网)。

**C. 设定台编辑对象** — 编辑"换皮后具体新书设定(4 块 + 溯源标)" vs 直接编辑抽象 4 层。
  推荐:**编辑具体设定 + 溯源标**(沿用现有 4 块,改动最小,仍呈现引擎/皮二元)。

---

## 7. 构建顺序(有序、含依赖)

- **Phase 0 地基**:schemas.py 4 层 + 角色输入;db.ts v9(4 层卡 + settingHistory)+ 存量标 legacy;store.ts 清字段 + STORE_VERSION 4。
- **Phase 1 引擎**:api `extract-book-direct` + reduce 改 4 层;`dnaEngine.ts` `routeBySize` 三档(复用 worker 池)。
- **Phase 2 换皮+补洞**:api 改 `generate-fusion-directions` 为角色制迁移 + 新增 `repair-setting-gaps`;方向加溯源。
- **Phase 3 共创地基**:api `enhance-instruction`;db settingHistory 接通;tweak 返回干净新块供 diff。
- **Phase 4 后台化**:导入后自动后台提取 + 通知;删档位/early-reduce 耦合;删双螺旋;限速改安静状态。
- **Phase 5 = A(UI 落地)**:按 `redesign-mockup.html` 逐屏替换组件(蓝图锁定后再做)。

**验证(无测试套件,CLAUDE.md 铁律):** 每 Phase 后 `npx tsc --noEmit` + `npm run lint` + `npm run build`,再手动走查(导入→后台提取→配方台指认→三方向→补洞→设定台 diff→成稿)。

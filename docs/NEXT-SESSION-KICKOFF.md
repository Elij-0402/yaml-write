# 下一会话 · 全量实现启动指令

> **用法:** 在新会话(工作目录 `D:\project`)里,直接粘贴下面【启动指令】整段;或更省事——只发这一句:
>
> **「读 `yaml-write/docs/NEXT-SESSION-KICKOFF.md` 并照它从 Phase 0 开始全量实现,逐 Phase 验证推进。」**
>
> (记忆会自动加载 `MEMORY.md`,其中已含本项目重定义与"对账真实代码"铁律的指针。)

---

## 【启动指令】(可整段粘贴)

全量实现「创作DNA工坊」的重定义。**先按顺序读完这四份已定稿的权威规格,勿推翻、勿重新讨论:**

1. `yaml-write/docs/PRD.md` — 产品需求(定位/目标用户/北极星旅程/FR/NFR/验收 AC/里程碑)
2. `yaml-write/docs/redesign-engine-blueprint.md` — 引擎实现蓝图(已逐文件对账真实代码 + 构建顺序 Phase 0→5 + 3 个锁定决策)
3. `yaml-write/docs/redesign-mockup.html` — **UX 唯一真相源**(前端逐屏必须符合;朱墨视觉系统;CSS 变量可直接从原型复用)
4. 记忆 `creative-dna-product-redefinition.md` — 决策摘要

读完后,照蓝图 **Phase 0→5** 把它实现进 `yaml-write/` 真实应用。**从 Phase 0 开始,逐 Phase 推进,每个 Phase 结束先验证、报告进度再继续。**

### 铁律(违反即返工)
- **先对账再改**:动任何文件前先读它的真实现状;**保留既有字段名/形状**;Dexie 形状变更必开**新 `version(n)` 块**,绝不改旧块;`api/schemas.py` ↔ `app/db.ts`/组件 **双侧逐字段同步(camelCase)**。(参见记忆 `bmad-epics-idealized-vs-shipped-code`)
- **UX 契约**:前端逐屏必须符合 `redesign-mockup.html`,偏离即不通过验收。动画**仅功能性**(墨落纸流式、diff 高亮、极简进度、当前步),删一切装饰。
- **三个锁定决策**:① 重 LLM 步骤(整本直提/reduce/换皮/补洞)**异步后台化**,不为 Vercel 10s 砍质量;② 旧 5 维 DNA 卡**惰性迁移**(标 legacy、原文不丢,重提时才升 4 层);③ 设定台编辑**"换皮后具体新书设定 + 引擎/题材溯源标"**,不编辑抽象 4 层。
- **别重造已就绪的链路**:`withRateLimitRetry` 限速护航、`onRehydrateStorage`/`persistError`、挂载自愈、`decryptKey` 损坏兜底、`streamSse`——保留,勿重写。
- **验证**(无 UI 测试套件):纯逻辑(按体量路由、4 层转换、diff/版本逻辑)走 `/tdd`;UI 靠**手动走查 + 对齐原型**。每个 Phase 后跑 `cd yaml-write && npx tsc --noEmit && npm run lint && npm run build`。
- 用户**非技术、极度偏好极简、厌恶花哨**;UI 用 `frontend-design` 技能的朱墨系统。

### 构建顺序(详见蓝图 §7)
- **Phase 0 地基**:`schemas.py` 4 层 DNA(`structureSkeleton`/`pacingSyuzhet`/`themeSkin`/`proseStyle`,引擎层 typed)+ 角色输入字段;`db.ts` 新增 `version(9)`(4 层卡 + `FusionSession.settingHistory`,旧卡标 legacy);`store.ts` 删 `sequencingGear`/`fusionBias`、temperature 滑块(保字段默认 0.7)、`STORE_VERSION`→4 + migrate。
- **Phase 1 自适应提取**:`api/index.py` 新增 `extract-book-direct`(整本长上下文→4 层)+ reduce 改 4 层;`dnaEngine.ts` 加 `routeBySize`(小=直提/中=按弧层级/大=饱和采样收敛即停),复用现有 worker 池,去档位依赖。
- **Phase 2 换皮+补洞**:`api/index.py` 改 `generate-fusion-directions` 为角色制类推迁移(去 fusionBias)+ **新增 `repair-setting-gaps`**;方向加溯源。
- **Phase 3 共创地基**:`api/index.py` 新增 `enhance-instruction`(意图增强带确认);tweak 返回干净新块供前端算 diff;`db.ts` `settingHistory` 接通(接受改动前快照,可回退)。
- **Phase 4 后台化与清理**:导入后自动后台提取 + "DNA 就绪"通知;删档位/early-reduce 耦合、双螺旋;限速改安静状态。
- **Phase 5 UI 落地**:按 `redesign-mockup.html` 逐屏替换组件(工作台/配方台/三方向/创世台/成稿);朱墨视觉;diff 接受/拒绝、版本回退、✨意图增强、选中句轻量改写。

### 完成定义(Definition of Done,= PRD §11 AC)
1. 交付 UX 逐屏符合 `redesign-mockup.html`。
2. 用户全程创作决策 ≤ 2(三选一 + 确认设定)。
3. 用户全程不接触任何参数旋钮。
4. 小/中/大三种体量都能自动提取(《斗破》级不卡死、不偏科)。
5. 换皮产出经补洞,开篇无明显逻辑断裂。
6. 任何 AI 改动先 diff、可拒、可回退,无静默覆盖。
7. 刷新/崩溃零丢失,提取可续跑。
8. 每 Phase `tsc + lint + build` 通过。

### 可选(想最大化彻底性 + 并行)
开头加关键词 **`ultracode`**,或说 **"use a workflow"**,让它用多 agent 编排把各 Phase 的实现+对抗式校验并行铺开(这是大改动,值得)。否则就单线程逐 Phase 稳扎稳打。

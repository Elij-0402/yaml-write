# 创作 DNA 工坊 — 主线重构蓝图

> 落地依据文档（到文件级）。所有论断已对照 `/d/project/yaml-write/` 真实代码核验；只采纳 verdict=confirmed/partial 的硬问题，refuted 的已剔除并说明。

---

## 1. 项目核心价值 & 北极星旅程

**价值主张：** 把"读过的几本网文"炼成可复用的创作 DNA，再让两份 DNA 在引力室里碰撞出原创新书的世界观、人物与开篇正文 —— 一句话：**喂书进去，流出新书的开篇。**

**北极星旅程（端到端理想态）：**

```
配置模型(BYOK) → 上传 TXT → 智能切分(必要时 JIT 语义裁切) → DNA 提取(Map-Reduce)
        → [≥1 本就绪] 引力室碰撞(可注入红队约束/偏向权重) → 三方向 → 创世台积木微调
        → 分镜故事板(1–8 镜可选, SSE 流式) → 逐镜流式成稿(可续写/断点续传) → 复制/下载
```

核心信念：**进度永不静默丢失**（已有 done 章持久化），**主线永远可见**（用户任何时刻知道"下一步该做什么、为什么某入口点不动"）。当前代码两条都未兑现 —— 本蓝图围绕这两条重排。

---

## 2. 现状问题总览（按严重度）

### Critical（阻断主线，必须先修）
- **刷新/崩溃后 DNA 提取永久卡死**：`analysisStatus` 持久化为 `mapping`/`reducing`（`dnaEngine.ts:209/348`），但只有运行中 abort 才会复位 idle（`dnaEngine.ts:338/380`）。重新进入 `NovelDetail`，`busy=true`（`NovelDetail.tsx:186`）→ 假进度面板；`pause()` 因 `abortRef.current===null`（`NovelDetail.tsx:209`）成空操作；提取按钮被 busy 分支隐藏（`NovelDetail.tsx:698-718`）。无任何挂载期对账逻辑（`page.tsx:32-57`、`NovelDetail` 4 个 useEffect、`db.ts` 迁移都不复位 truthy 的孤儿状态）。章节 `mapStatus` 同样卡 `mapping` 且该分支无重试按钮（`NovelUploader.tsx:1420-1426`）。唯一脱困是重切（删全部章+丢 DNA）。

### High
- **切分失败修复入口被甩到另一视图**：上传成功 `setSelectedNovelId` 强制 `manageMode:false`（`store.ts:213`）→ 落到 `NovelDetail`，而 `needs_review` 横幅/智能修复/语义拆分全在 `NovelUploader` 管理视图（`NovelUploader.tsx:1212/1225/1254/1293`）。`NovelDetail` 提取前 CTA 完全不读 `splitStatus`（`NovelDetail.tsx:698-720`），坏切分被直接引导去提取 DNA。
- **巨型单章 >30000 字报错让用户"去裁切"，但同屏无裁切工具**（`dnaEngine.ts:197-200` + `NovelDetail.tsx:722-727`）。错误文本非链接、不路由；唯一出口是顶栏"章节微调裁切"按钮（partial：非死胡同，但摩擦重，且语义拆分入口受 `canSmartSplit` 限制）。
- **Map 全失败后文案"请点击继续提取"，但本板无此按钮**（`dnaEngine.ts:344` + `NovelDetail.tsx:698-718`）。再点"深度全量"才会断点续跑，措辞与 UI 不符。
- **DNA 就绪后无"重测/续测"入口**：`dnaReady` 分支只渲染五维卡（`NovelDetail.tsx:340-462`），快速提取(前100章)后想补测 101+ 章在本板无路径（partial：可经顶栏跳管理视图逐章精测，但无批量 CTA）。
- **红队约束 adversarialRules 前端完全不可达**：后端 4 个 schema / 5 个 handler 全支持（`schemas.py:81/107/140/153`；`index.py:487/541/581/618/690`），前端 `FusionWorkshop` 4 个调用无一传，全前端 grep 0 命中。CLAUDE.md:125 宣称引力室有该输入框 —— 不实。
- **单本 DNA 无法进引力室**：后端 `dnaCards min_length=1`（`schemas.py:79`）支持单本，前端 6 处硬卡 ≥2 本（`FusionWorkshop.tsx:140/222/446/618-619/633/747`）。
- **融合工坊全程零持久化**：方向/积木/故事板/已生成正文全是组件 useState（`FusionWorkshop.tsx:143-170`），刷新或点侧栏即蒸发，无 `beforeunload` 警告。
- **窄屏无全局导航**：sidebar `hidden ... lg:flex`（`page.tsx:81`），lg 以下无法切换作品/进工坊/开设置（设置可经错误驱动事件打开，partial）。header 无汉堡菜单（`page.tsx:160-169`）。
- **runResplit 未检查 analysisStatus**：提取进行中切到管理视图重切会删正在写入的章、把旧 DNA 写到已重置的 novel 上（`NovelUploader.tsx:921-925` + `dnaEngine.ts:271/377`）。
- **localStorage/persist 失败无任何提示**：隐私模式/配额满导致 key 反复丢失，无 `onRehydrateStorage` 错误回调（`store.ts`）。

### Medium
- **微调命令"石沉大海"**：模型未命中 `tweakTarget` 时 `effectiveKeys=[]` 不改任何块，却仍 `setCommand('')` 清空且无任何反馈（`FusionWorkshop.tsx:309-321`）。（注：原审计"丢弃多块修改"refuted —— 后端被 targetBlock 硬约束只返回单块，无多块可丢；真正缺陷是空命中静默。）
- **sceneCount 锁死 3**：`FusionWorkshop.tsx:346` 硬编码，后端支持 1-8。
- **temperature 锁死 0.7**：全前端无 setter、无 UI（`store.ts` 无 `setTemperature`；`SettingsPanel`/水晶卡只有 key/url/model），后端支持 0-1.5。
- **融合工坊 429 无护航**：4 个 LLM 调用直接抛红字（`FusionWorkshop.tsx:256/307/367/418`），无退避无冷却，与 DNA 阶段（`dnaEngine.ts:85-119` + `NovelDetail.tsx:593-600` amber 气泡）割裂。
- **故事板流式无续传**：断流只能整体重来且先清空已有成果（`FusionWorkshop.tsx:337-339,363-364`）；正文流有"继续接写"（做得好）。
- **流式无取消按钮、切 step 不 abort**：`generateStoryboard`/`generateScene` 不传 `signal`（`FusionWorkshop.tsx:344/389`），卸载后仍 setState（React 18 静默 no-op，但仍耗 token）。
- **撤销备份 >4MB 被静默禁用，撤销按钮仍可见**（`NovelUploader.tsx:282-285,366-370`）。
- **任意 success toast 倒计时误删 stitch 撤销备份**（`NovelUploader.tsx:597-611`）。
- **重切不清 `selectedChapterIds`**，残留选择指向已删章，批量合并静默失效（`NovelUploader.tsx:838-879`）。
- **刷新后选中已删除作品 → 幽灵选中**：右栏分支用 `selectedNovelId` 真值而非 `selectedNovel`（`page.tsx:174`），面包屑/侧栏/右栏三处不一致。
- **reducing 无 Vercel 10s 风险提示**（`NovelDetail.tsx:583-589`）。
- **decryptKey 解密失败静默返回密文** → 乱码 key 被判"已就绪"（`store.ts:57`，低频但真实）。

### 已剔除（refuted）
- ~~"rateLimited 是未消费的能力空洞"~~：**剔除** —— 实际已端到端接通（`dnaEngine.ts` 设置 + `NovelDetail.tsx:515/593-600` 消费）。真实问题降级为"429 护航仅作用于提取视图，未进 header/工坊"。
- ~~"工作流 hint 文案是死代码因为 workflow.ts 不存在"~~ 的反向：`workflow.ts` **存在且 `getNovelWorkflowSummary` 确为死代码**（仅 `page.tsx:11`/`NovelDetail.tsx:9` 引入且只用 `getLlmReadinessSummary`）—— 这是真问题，正好作为新 stepper 的现成数据源。

---

## 3. 重新设计的主线用户旅程

### 3.1 新导航信息架构：用"进度主线 Stepper"取代三标志拼凑

**核心思路：** 复用已写好却从未被调用的 `getNovelWorkflowSummary`（`workflow.ts:32-179`，已含 4 阶段 + status + hint + recommendedNextStep）作为唯一真相源，把它从死代码变成顶部常驻 stepper。

**4 阶段门（随小说状态自动解锁/跳转）：**

| 阶段 | 解锁条件（派生自数据） | 点击行为 | status 映射 |
|---|---|---|---|
| ① 导入 | 恒可用 | 切到 NovelUploader 拖拽舱 | 有 novel → done |
| ② 校验切分 | `selectedNovel` 存在 | 切到 NovelUploader 管理视图 | `splitStatus==='needs_review'` → blocked(红)，否则 done |
| ③ 提取 DNA | 切分 ok 且 LLM 就绪 | 切到 NovelDetail | `mapping/reducing`→running，`done&&dnaCard`→done，`!llm.ok`→blocked，`needs_review`→blocked |
| ④ 融合变体 | **≥1 本 DNA 就绪**（放宽，下文）| 切到 FusionWorkshop | `readyCount≥1`→ready，否则 idle/blocked |

**新增组件 `components/WorkflowStepper.tsx`**：消费 `getNovelWorkflowSummary(selectedNovel, llmConfig, readyCount)`，复用 `getStageStatusClasses`（`workflow.ts:181`）。渲染在 `page.tsx` header 下方一行。空库时 stepper 显示"导入第一部作品 → … → 至少 2 部才能融合"，**首次用户立刻看到完整主线**（解决最 high 的"无新手引导"）。

> 保留底层三标志（`workshopOpen/selectedNovelId/manageMode`）作为渲染开关 —— 改动最小，零迁移风险 —— 但**导航语义层**全部由 stepper + `recommendedNextStep` 驱动，用户不再直面三标志的拼凑。

**窄屏导航**：`page.tsx` header 增加一个汉堡按钮（`<lg` 显示）→ 翻转一个 `mobileNavOpen` 本地 state → 把现有 `<aside>` 改为 `${mobileNavOpen ? 'flex' : 'hidden'} lg:flex` 的抽屉（fixed + 遮罩）。这一处改动让作品切换/工坊/设置在移动端全部可达。

### 3.2 各阶段的状态与关键交互

**① 导入（NovelUploader 拖拽舱，`:1110-1149`）**
- 空态：拖拽舱 + 一句主线说明（"配模型 → 导入 → 提取 DNA → 至少 2 部可融合"，新增文案）。
- 加载：Worker 进度（已有 stageLabelMap）。新增"已净化 N 字"展示（消费现存 `purifiedCount`，`db.ts:83`，当前全程不显示）。
- 错误：编码失败横幅（已有 watchdog）。
- 成功：**改路由策略** —— 若 `splitStatus==='needs_review'` 则 `setManageMode(true)` 落到校验视图而非 NovelDetail；否则照旧。

**② 校验切分（NovelUploader manageMode）**
- 进入：从 stepper ②、或上传 needs_review 自动落地、或 NovelDetail 顶栏"章节微调裁切"。
- 关键交互：保留智能修复/高级正则/✨语义拆分/缝合/裁切。
- **放宽 `canSmartSplit`**（`:192-195`）：除"章数≤1"外，增加"存在单章 >30000 字"也允许对该超大章 `runSmartSplit`，覆盖"前言/序 + 巨型单章=2章"被挡的场景。
- 修复无效反馈：`doResplit` 成功后若仍 `needs_review`，提示"重切未提升置信度，建议改用自定义正则/语义拆分"。
- 错误：split-recommend 429 增加冷却提示（复用下文统一 429 helper）。

**③ 提取 DNA（NovelDetail）**
- 进入：**挂载对账** —— 新增 useEffect：若 `analysisStatus∈{mapping,reducing}` 且 `abortRef.current===null`，则 `db.novels.update(idle)` + 把 `mapStatus==='mapping'` 章回滚 `pending`，并 toast"检测到中断的提取，已重置，可继续"。这一处直接解 Critical。
- 提取前：`renderSpeedDial` + 两个提取按钮 + **新增 needs_review/超大章横幅**（一键 `setManageMode(true)` 去修复）。
- 进行中：双螺旋 + 进度 + 暂停 + 阶段汇总（保留）；reducing 文案加"整书归纳较慢，Vercel 部署可能受 10s 限制"。
- 429：保留 amber 气泡，文案区分"临时拥挤 vs 可能额度耗尽"（退避耗尽时）。
- error 态：**新增"继续提取(仅重试失败章)"显式按钮**（兑现 `dnaEngine.ts:344` 文案）+ 失败章列表（`chapters.filter(mapStatus==='error')`）。
- done 态：五维卡 + **新增"补测剩余章/全量重测"次要按钮**（调 `handleExtract(undefined)`，confirm 会覆盖现有 DNA）。
- 并发护栏：`runResplit` 开头加 `analysisStatus==='mapping'/'reducing'` 守卫（复用 `handleSingleChapterExtract:533` 范式），解并发删章 Bug。

**④ 融合工坊（FusionWorkshop）**
- 进入：**门槛降到 ≥1 本**（改 6 处 `<2` 判定）。单本走"自我裂变"语义；2 本走电影碰撞 + fusionBias；≥3 本 fusionBias 传 0.5（后端仅 2 本生效，加说明文案）。
- 引力室：**新增"反套路红队约束(可选)"textarea**（独立于现有"偏航指令"），值存 `adversarialRules` state。新增 **sceneCount 选择器(1-8)**。
- 碰撞→方向→创世台→分镜→成稿：保留三步漏斗。
- 微调：空命中时 toast"模型判断该指令未改动目标块，可改写指令或切目标块"，仅在确有写回时才 `setCommand('')`。
- 流式：新增 `AbortController` + "停止生成"按钮，传 `signal`；卸载 abort。
- 429：复用统一 helper，限速时显示冷却提示。
- 重选方向丢正文：`chooseDirection` 前若 `Object.keys(sceneTexts).length>0` 弹 confirm"将清空已生成正文"。
- **持久化（见 3.3）**：方向/积木/故事板/正文落 IndexedDB，刷新可恢复 + `beforeunload` 警告。
- 复制反馈：`copyScene` 包 try/catch + "已复制" toast；下载文件名 sanitize（`replace(/[\\/:*?"<>|\n]/g,'_')`）。

### 3.3 状态模型改动（尽量小）

**`app/store.ts`：**
- 新增 `setTemperature(v)` → `set({ llmConfig: { ...s.llmConfig, temperature: clampTemperature(v) } })`（复用现存 `clampTemperature`）。
- `decryptKey` catch 改为 `return ''`（损坏密文视为未配置，解 401 假就绪）。
- 新增 `onRehydrateStorage` 回调：捕获 persist 失败 → 设一个 `persistError` 标志供 header 提示（隐私模式/配额满）。
- （不动三标志，不动 migrate 的强制 reset。）

**`app/db.ts`：新增 `version(7)`（铁律：形状变更必须新版本块）**
- 新增 `fusionSessions` 表：`'id, novelKey, updatedAt'`，存 `{ id, selectedIds, step, directions, blocks, directionTitle, storyboard, sceneTexts, sceneResumeStatus, updatedAt }`。这是工坊持久化的最小落地点（解"刷新丢正文"+ 兑现"一切持久化于浏览器"）。
- `version(7).upgrade` 仅建表，不回填存量（避免启动阻塞）。

**`app/workflow.ts`：** 无需改 —— 已写好的 `getNovelWorkflowSummary`/`getStageStatusClasses` 直接被新 `WorkflowStepper` 消费（从死代码激活）。

### 3.4 当前被隐藏/未接通的后端能力 → 新旅程如何 surface

| 后端能力 | 现状 | 新旅程 surface 方式 |
|---|---|---|
| `stream-storyboard`（SSE 流式故事板） | wired（CLAUDE.md 漏记） | 保持现状；同步更正 CLAUDE.md 端点表，明确前端走 SSE、`generate-storyboard` 仅后端回退 |
| `split-recommend`（JIT 语义拆分） | wired 但入口窄 | 放宽 `canSmartSplit`；在 NovelDetail 超大章报错处加"去裁切"跳转，形成闭环 |
| `fusionBias`（仅 2 本生效） | wired | 保留滑块；加文案"3 本及以上权重不生效"；单本路径传 0.5 |
| `adversarialRules`（红队，4 schema/5 handler） | **0/4 未接通** | 引力室新增独立 textarea，透传到 collide/runTweak/generateStoryboard/generateScene 全部 4 个调用体 |
| `temperature`（0-1.5） | 锁死 0.7，无 setter/UI | store 加 `setTemperature` + SettingsPanel 加滑块（复用 `glowing-slider` 范式）|
| `sceneCount`（1-8） | 硬编码 3 | 生成故事板旁加 1-8 选择器，传入 stream-storyboard payload |
| 分镜续写 `currentDraft`/`resumeFromText` | wired 但发同值（后端坍缩） | 区分语义：断点续传用 `resumeFromText`（接续半截），分镜续写用 `currentDraft`；或去冗余只发其一 + 加续写去重 |

---

## 4. 优先级问题/Bug 账本

| # | 标题 | file:line | 严重度 | 修复方向 |
|---|---|---|---|---|
| 1 | 刷新后 DNA 提取永久卡 mapping/reducing，暂停失效 | `components/NovelDetail.tsx:186,209` + `app/dnaEngine.ts:209,348` | critical | 挂载对账 useEffect：孤儿 mapping/reducing → `db.novels.update(idle)` + 章 `mapping→pending`；pause 在 abortRef 空时也复位 idle |
| 2 | 章节 mapStatus 卡 mapping 转圈且无重试 | `components/NovelUploader.tsx:1420-1426` + `app/dnaEngine.ts:271` | high | 同 #1 对账批量回 pending；或 mapping 分支也给重试入口 |
| 3 | runResplit 未检查 analysisStatus，删正在写入的章 | `components/NovelUploader.tsx:921-925` | high | 开头加 `analysisStatus==='mapping'/'reducing'` 守卫并提示 |
| 4 | 上传后落 NovelDetail，needs_review 修复入口不可见 | `components/NovelUploader.tsx:742` + `components/NovelDetail.tsx:698-720` | high | 上传成功若 needs_review → setManageMode(true)；NovelDetail 提取前加 needs_review 横幅+跳修复 |
| 5 | Map 全失败文案"继续提取"无对应按钮 | `app/dnaEngine.ts:344` + `components/NovelDetail.tsx:698-718` | high | error 态新增显式"继续提取(重试失败章)"按钮 + 失败章列表 |
| 6 | 红队 adversarialRules 前端 0/4 未接通 | `components/FusionWorkshop.tsx:251-255,302-306,344-346,389-397` | high | 引力室加 textarea，4 个调用体透传 `adversarialRules` |
| 7 | 单本 DNA 无法进引力室 | `components/FusionWorkshop.tsx:140,222,446,618-619,633,747` | high | 6 处 `<2` 放宽到 `<1`；单本走自裂变、fusionBias 传 0.5、跳过电影动画 |
| 8 | 融合工坊零持久化，刷新丢正文 | `components/FusionWorkshop.tsx:143-170` | high | 新增 `db.fusionSessions` 表落盘 + beforeunload 警告 |
| 9 | 窄屏无全局导航 | `app/page.tsx:81` | high | header 加汉堡 + aside 改抽屉 |
| 10 | persist 失败/key 丢失无提示 | `app/store.ts:222` | high | 加 onRehydrateStorage 错误回调 + header 提示 |
| 11 | 微调空命中静默清空命令无反馈 | `components/FusionWorkshop.tsx:309-321` | medium | 仅有写回才 setCommand('')；空结果 toast 提示 |
| 12 | sceneCount 锁死 3 | `components/FusionWorkshop.tsx:346` | medium | 加 1-8 选择器并传值 |
| 13 | temperature 锁死 0.7 无 UI | `app/store.ts`（无 setTemperature）+ `components/SettingsPanel.tsx` | medium | store 加 setTemperature + SettingsPanel 加滑块 |
| 14 | 工坊 429 无护航/退避 | `components/FusionWorkshop.tsx:256,307,367,418` | medium | 抽 `withRateLimitRetry` 为通用 helper，统一 429 体验 |
| 15 | 故事板流式无续传、重来先清空 | `components/FusionWorkshop.tsx:337-339,363-364` | medium | 解析失败保留 streamText 给就地"重试"按钮，不立即清空 |
| 16 | 流式无取消、切 step 不 abort | `components/FusionWorkshop.tsx:344,389` | medium | 加 AbortController + "停止生成" + 卸载 abort |
| 17 | 巨型单章报错不路由到裁切 | `app/dnaEngine.ts:197-200` + `components/NovelDetail.tsx:722-727` | medium(partial) | 错误处加"去裁切"按钮 setManageMode(true) |
| 18 | 撤销备份>4MB 静默禁用但按钮仍可点 | `components/NovelUploader.tsx:282-285,366-370` | medium | 备份失败时不渲染撤销按钮或提示"过大不可撤销" |
| 19 | toast 倒计时误删 stitch 撤销备份 | `components/NovelUploader.tsx:597-611` | medium | 清理仅在 `toast.type==='stitch'` 时删备份 |
| 20 | 重切不清 selectedChapterIds → 批量合并失效 | `components/NovelUploader.tsx:838-879` | medium | doResplit 成功分支补 `setSelectedChapterIds(new Set())` |
| 21 | 刷新后幽灵选中（指向已删作品） | `app/page.tsx:174` | medium | 右栏分支用 `selectedNovel && !manageMode`；useEffect 检测失效 ID 清空 |
| 22 | done 后无重测/补测入口 | `components/NovelDetail.tsx:340-462` | medium(partial) | done 态加"补测剩余/全量重测"按钮 |
| 23 | reducing 无 10s 风险提示 | `components/NovelDetail.tsx:583-589` | medium | reducing 文案加耗时/Vercel 提示 |
| 24 | 复制无反馈/下载文件名未消毒 | `components/FusionWorkshop.tsx:431-433,440` | medium | copyScene try/catch+toast；download 文件名 sanitize |
| 25 | decryptKey 失败返回密文→假就绪 | `app/store.ts:57` | low | catch 返回 '' |
| 26 | 分镜续写 currentDraft/resumeFromText 发同值 | `components/FusionWorkshop.tsx:395-396` | low | 区分语义或去冗余 + 续写去重 |

---

## 5. 落地实施计划（有序、到文件级、含依赖与风险）

**Phase 0 — 数据层与状态层地基（其他改动依赖此层）**
1. `app/db.ts`：新增 `version(7)` + `fusionSessions` 表（仅建表，不回填）。风险：低；铁律遵守"新版本块"。
2. `app/store.ts`：加 `setTemperature`（接口 + 实现）；`decryptKey` catch 返回 `''`；加 `onRehydrateStorage` 错误回调暴露 `persistError`。风险：低。

**Phase 1 — Critical 死锁与并发护栏（最高优先）**
3. `components/NovelDetail.tsx`：挂载对账 useEffect（孤儿 mapping/reducing → idle + 章 mapping→pending + toast）；pause 在 abortRef 空时直接复位 idle。依赖：无。风险：中（需确保 useLiveQuery 数据到达后再对账，避免误清正在跑的本会话任务 —— 用 `abortRef.current===null && !extracting` 双判）。
4. `components/NovelUploader.tsx`：`runResplit` 加 `analysisStatus` 守卫；`doResplit` 成功补 `setSelectedChapterIds(new Set())`/`setActiveChapterId(null)`。依赖：无。风险：低。

**Phase 2 — 导航与主线可见性**
5. `components/WorkflowStepper.tsx`（新建）：消费 `getNovelWorkflowSummary`/`getStageStatusClasses`。依赖：无（workflow.ts 已存在）。风险：低。
6. `app/page.tsx`：挂 WorkflowStepper；汉堡菜单 + aside 抽屉；右栏分支改 `selectedNovel && !manageMode` + 失效 ID 清空 useEffect；空库主线文案。风险：中（响应式回归 —— 桌面端 `lg:flex` 行为须保持不变）。
7. `components/NovelDetail.tsx`：提取前 needs_review/超大章横幅（跳 setManageMode）；上传路由策略在 `NovelUploader.tsx:742` 改为 needs_review→manageMode。依赖：步骤 5/6。风险：低。

**Phase 3 — DNA 阶段补全**
8. `components/NovelDetail.tsx`：error 态"继续提取(重试失败章)"按钮 + 失败章列表；done 态"补测/重测"按钮；reducing 10s 提示；429 文案区分。依赖：Phase 1。风险：低。
9. `components/NovelUploader.tsx`：放宽 `canSmartSplit`（超大章也允许）；重切未提升反馈；显示 `purifiedCount`；撤销备份禁用时隐藏按钮；toast 清理仅 stitch 删备份。风险：低。

**Phase 4 — 融合工坊能力 surface（依赖 Phase 0 持久化表）**
10. `components/FusionWorkshop.tsx`：① 6 处门槛 `<2`→`<1`（单本路径）；② 引力室加 `adversarialRules` textarea + 4 调用透传；③ sceneCount 1-8 选择器；④ AbortController+停止按钮+卸载 abort；⑤ 微调空命中反馈；⑥ chooseDirection 重选 confirm；⑦ 复制 toast + 下载文件名消毒；⑧ 接 `db.fusionSessions` 持久化 + beforeunload；⑨ 故事板失败保留 streamText 给重试。依赖：步骤 1。风险：中（状态机改动面大，需保证三步漏斗回归不破）。
11. `app/llmClient.ts` 或新 `app/rateLimit.ts`：抽 `withRateLimitRetry` 为通用 helper，工坊 4 调用接入 + 复用 `setRateLimited`。依赖：步骤 10。风险：中（SSE 与普通 POST 退避语义需分别处理）。
12. `components/FusionWorkshop.tsx`：分镜 `currentDraft`/`resumeFromText` 区分语义 + 续写去重。风险：低。

**Phase 5 — 设置与文档**
13. `components/SettingsPanel.tsx`：加 temperature 滑块（绑 `setTemperature`，复用 glowing-slider）。依赖：步骤 2。风险：低。
14. `CLAUDE.md`：补记 `stream-storyboard`/`split-recommend` 端点；更正"引力室有红队约束输入框"（改为已新增）；更正 `MAP_CONCURRENCY` 固定 3（实为 safe1/balanced3/speed8）。风险：无。

**全局验证**（无测试套件）：每 Phase 后 `npx tsc --noEmit` + `npm run build`，再手动走查关键旅程（刷新中断恢复、单本融合、窄屏导航、红队约束透传）。

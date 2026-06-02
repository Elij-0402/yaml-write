# 落地计划（结构化）

## Critical / 高优问题账本

1. **刷新/崩溃后 DNA 提取永久卡死在 mapping/reducing，进度条与暂停键全部失效** (critical)
   - 位置: components/NovelDetail.tsx:186,209 + app/dnaEngine.ts:209,348,338,380
   - 修复: 在 NovelDetail 挂载时新增对账 useEffect：当 analysisStatus∈{mapping,reducing} 且 abortRef.current===null 且 !extracting 时，db.novels.update(novelId,{analysisStatus:'idle'}) 并把该 novel 下 mapStatus==='mapping' 的章回滚为 'pending'，toast 提示已重置可继续；并让 pause() 在 abortRef 为空时也直接复位 idle。
2. **章节 mapStatus 卡 'mapping' 刷新后永久转圈且该渲染分支无任何重试按钮** (high)
   - 位置: components/NovelUploader.tsx:1420-1426 + app/dnaEngine.ts:271,280
   - 修复: 随 NovelDetail 挂载对账一并批量把孤儿 mapping 章回滚 pending；或在 NovelUploader 的 mapping 渲染分支补一个重试/重置入口（当前精测按钮只在 done/error/pending 分支）。
3. **runResplit 未检查 analysisStatus，提取进行中重切会删正在写入的章并把旧 DNA 写到已重置的 novel** (high)
   - 位置: components/NovelUploader.tsx:921-925
   - 修复: runResplit 开头复用 handleSingleChapterExtract(:533) 的守卫：if (activeNovel?.analysisStatus==='mapping'||'reducing') { toast('请先暂停/等待提取完成再重切'); return; }。
4. **上传成功后落到 NovelDetail，needs_review 切分修复入口被甩到另一视图且 NovelDetail 完全不读 splitStatus** (high)
   - 位置: components/NovelUploader.tsx:742 + components/NovelDetail.tsx:698-720
   - 修复: processFile 成功后若 splitStatus==='needs_review' 则 setManageMode(true) 落到校验视图；并在 NovelDetail 提取前 CTA 加 needs_review/超大章醒目横幅 + 一键 setManageMode(true) 跳修复。
5. **Map 全失败后错误文案让用户'点击继续提取'，但本板没有任何叫'继续提取'的按钮** (high)
   - 位置: app/dnaEngine.ts:344 + components/NovelDetail.tsx:698-718
   - 修复: 在 status==='error' 态新增显式'继续提取(仅重试失败章)'按钮(调 handleExtract)，并列出 chapters.filter(mapStatus==='error') 失败章；兑现文案。
6. **反套路红队约束 adversarialRules 后端 4 schema/5 handler 全支持，前端 0/4 调用接通且无任何 UI** (high)
   - 位置: components/FusionWorkshop.tsx:251-255,302-306,344-346,389-397
   - 修复: 引力室新增独立'反套路红队约束'textarea(区别于现有偏航指令customPrompt→userCustomPrompt)，把其值作为 adversarialRules 透传到 generate-fusion-directions/tweak-fusion-blocks/stream-storyboard/stream-scene-text 全部 4 个请求体。
7. **单本 DNA 无法进入引力室，前端 6 处硬卡 ≥2 本，阉割后端 dnaCards min_length=1 能力** (high)
   - 位置: components/FusionWorkshop.tsx:140,222,446,618-619,633,747
   - 修复: 把全部 6 处 readyNovels.length<2 / selectedIds.length<2 判定放宽到 <1；单本走'自我裂变'语义、fusionBias 传 0.5、跳过仅 2 本的电影级碰撞动画。
8. **融合工坊全流程零持久化，刷新或点侧栏离开即丢失方向/积木/故事板/已生成正文** (high)
   - 位置: components/FusionWorkshop.tsx:143-170
   - 修复: app/db.ts 新增 version(7) + fusionSessions 表，把 step/selectedIds/directions/blocks/storyboard/sceneTexts 落盘并在挂载时恢复；离开前 beforeunload 警告未保存正文。
9. **窄屏(移动端)无任何全局导航：无法切换作品/进工坊/开设置** (high)
   - 位置: app/page.tsx:81,160-169
   - 修复: header 增加汉堡按钮(<lg显示)翻转 mobileNavOpen，将现有 aside 改为带遮罩的抽屉(${mobileNavOpen?'flex':'hidden'} lg:flex)，桌面端 lg:flex 行为不变。
10. **localStorage/persist 失败(隐私模式/配额满)无任何提示，BYOK key 反复静默丢失** (high)
   - 位置: app/store.ts:222
   - 修复: persist 增加 onRehydrateStorage 错误回调，捕获反序列化失败 → 暴露 persistError 标志，在 header 提示'配置未能保存'；并把 decryptKey 解密失败的 catch 从 return 密文改为 return '' 以避免乱码 key 被判'已就绪'。
11. **微调命令在模型未命中目标块时静默清空输入框且无任何反馈** (medium)
   - 位置: components/FusionWorkshop.tsx:309-321
   - 修复: 仅当确有积木被写回(effectiveKeys 非空)时才 setCommand('')；否则保留指令并 toast'模型判断该指令未改动目标块，可改写指令或切换目标块'。注意:原审计'丢弃后端多块修改'已被推翻(后端被 targetBlock 硬约束只返回单块),真实缺陷仅是空命中静默。
12. **sceneCount 锁死 3 与 temperature 锁死 0.7，后端 1-8 / 0-1.5 能力不可达** (medium)
   - 位置: components/FusionWorkshop.tsx:346 + app/store.ts(无setTemperature) + components/SettingsPanel.tsx
   - 修复: FusionWorkshop 生成故事板旁加 1-8 选择器并传入 stream-storyboard；store 新增 setTemperature(clamp 0-1.5)，SettingsPanel 加温度滑块(复用 glowing-slider 范式)。
13. **融合工坊 4 个 LLM 调用对 429 无退避无冷却提示，与 DNA 阶段护航割裂** (medium)
   - 位置: components/FusionWorkshop.tsx:256,307,367,418
   - 修复: 将 dnaEngine.ts:85-119 的 withRateLimitRetry 抽为通用 helper(或 app/rateLimit.ts)，工坊 collide/runTweak/generateStoryboard/generateScene 接入并复用 setRateLimited，限速时显示冷却气泡。
14. **流式生成无取消按钮、切 step 不 abort 进行中的 SSE** (medium)
   - 位置: components/FusionWorkshop.tsx:344,389
   - 修复: 为 generateStoryboard/generateScene 各建 AbortController 经 streamSse 的 handlers.signal 传入；UI 加'停止生成'按钮；组件卸载 useEffect 内 abort。

## 实施步骤（有序）

### Step 1 · 数据层
- 文件: app/db.ts
- 改动: 新增 version(7).stores({...}).upgrade()，登记 fusionSessions 表 'id, novelKey, updatedAt'，仅建表不回填存量。
- 理由: 为融合工坊持久化提供落地点，兑现'一切持久化于浏览器'承诺。其他工坊改动依赖此表。
- 风险: 低；遵守 Dexie 铁律(形状变更必须新版本块，不动旧版本定义)。

### Step 2 · 状态层
- 文件: app/store.ts
- 改动: AppState 加 setTemperature(clamp 0-1.5)；decryptKey catch 返回 ''(而非密文)；persist 增 onRehydrateStorage 错误回调暴露 persistError。
- 理由: 解锁后端温度能力、修复乱码 key 假就绪、修复 persist 静默失败无提示。
- 风险: 低；不改三标志与 migrate 强制 reset。

### Step 3 · DNA 死锁(Critical)
- 文件: components/NovelDetail.tsx
- 改动: 挂载对账 useEffect：孤儿 mapping/reducing 且 abortRef 空且 !extracting → db.novels.update(idle) + 章 mapping→pending + toast；pause 在 abortRef 空时也复位 idle。
- 理由: 解最高优先级 critical 死锁，刷新后提取板可恢复。
- 风险: 中；用 abortRef.current===null && !extracting 双判避免误清本会话正在跑的任务。

### Step 4 · 并发护栏
- 文件: components/NovelUploader.tsx
- 改动: runResplit(:922) 加 analysisStatus==='mapping'/'reducing' 守卫；doResplit 成功补 setSelectedChapterIds(new Set())/setActiveChapterId(null)。
- 理由: 防提取进行中重切删正在写入的章造成状态错乱；修复重切后残留选择导致批量合并失效。
- 风险: 低。

### Step 5 · 导航主线
- 文件: components/WorkflowStepper.tsx(新建)
- 改动: 消费 getNovelWorkflowSummary/getStageStatusClasses(workflow.ts 已存在)，渲染 4 阶段门(导入/切分/DNA/融合)及 status 颜色与 recommendedNextStep。
- 理由: 把死代码 getNovelWorkflowSummary 激活为常驻 stepper，让首次用户立刻看到完整主线、知道为何融合点不动。
- 风险: 低；纯展示组件。

### Step 6 · 导航主线
- 文件: app/page.tsx
- 改动: header 挂 WorkflowStepper；加汉堡按钮(<lg)+ aside 改带遮罩抽屉(mobileNavOpen);右栏分支改 selectedNovel && !manageMode + useEffect 检测失效 ID 清空 setSelectedNovelId(null);空库主线说明文案。
- 理由: 解窄屏无导航、刷新幽灵选中、首次无引导三个 high 问题。
- 风险: 中；需保证桌面端 lg:flex 现有行为不回归。

### Step 7 · 切分修复可见性
- 文件: components/NovelUploader.tsx, components/NovelDetail.tsx
- 改动: processFile 成功(:742)若 needs_review → setManageMode(true)落校验视图;NovelDetail 提取前 CTA(:698) 加 needs_review/超大章横幅 + 一键 setManageMode(true)跳修复。
- 理由: 解切分失败修复入口不可见、坏切分被引导直接提取 DNA 的 high journeyBreak。
- 风险: 低；依赖步骤 5/6 的路由语义。

### Step 8 · DNA 阶段补全
- 文件: components/NovelDetail.tsx
- 改动: error 态加'继续提取(重试失败章)'按钮+失败章列表(mapStatus==='error');done 态加'补测剩余/全量重测'按钮;reducing 加 Vercel 10s 耗时提示;429 文案区分临时拥挤/额度耗尽。
- 理由: 兑现 dnaEngine.ts:344 文案、补 done 后无重测入口、补 reducing 超时预期。
- 风险: 低；依赖步骤 3 的对账保证状态可用。

### Step 9 · 切分台细节
- 文件: components/NovelUploader.tsx
- 改动: 放宽 canSmartSplit(:192-195)增加'存在单章>30000字'分支;重切后仍 needs_review 给改善反馈;显示 purifiedCount;撤销备份禁用时隐藏按钮;toast 清理仅 stitch 删备份(:604)。
- 理由: 覆盖前言+巨型单章被挡场景、修复无效循环无反馈、净化不可见、撤销静默无效、备份误删等 medium 问题。
- 风险: 低。

### Step 10 · 融合工坊能力
- 文件: components/FusionWorkshop.tsx
- 改动: 6 处<2 门槛放宽到<1(单本路径);引力室加 adversarialRules textarea+4 调用透传;sceneCount 1-8 选择器;AbortController+停止按钮+卸载 abort;微调空命中反馈;chooseDirection 重选 confirm;复制 toast+下载文件名消毒;接 db.fusionSessions 持久化+beforeunload;故事板失败保留 streamText 给重试。
- 理由: 集中解工坊全部 high/medium:单本碰撞、红队不可达、零持久化、sceneCount/流式取消/微调反馈/重选丢正文等。
- 风险: 中;状态机改动面大,需回归三步漏斗(碰撞→方向→创世台)与续写功能。

### Step 11 · 限流统一
- 文件: app/llmClient.ts 或 app/rateLimit.ts(新建), components/FusionWorkshop.tsx
- 改动: 抽 withRateLimitRetry 为通用 helper,工坊 4 调用接入并复用 setRateLimited,限速显示冷却气泡。
- 理由: 统一 429 体验,消除工坊与 DNA 阶段的护航割裂。
- 风险: 中;SSE 与普通 POST 退避语义需分别处理(SSE 中途断不可简单重放)。

### Step 12 · 分镜续写语义
- 文件: components/FusionWorkshop.tsx
- 改动: 区分 currentDraft(分镜续写)/resumeFromText(断点续传)语义或去冗余只发其一;续写返回做前缀重叠去重。
- 理由: 消除两参数坍缩的意图歧义、防模型复述导致双写。
- 风险: 低。

### Step 13 · 设置
- 文件: components/SettingsPanel.tsx
- 改动: 加 temperature 滑块(0-1.5,绑 setTemperature,复用 glowing-slider 范式)。
- 理由: surface 后端温度能力,给创作随机性控制。
- 风险: 低;依赖步骤 2 的 setTemperature。

### Step 14 · 文档
- 文件: CLAUDE.md
- 改动: 补记 stream-storyboard/split-recommend 端点;更正'引力室有红队约束输入框'(改为已新增);更正 MAP_CONCURRENCY 固定3(实为 safe1/balanced3/speed8)。
- 理由: 消除文档与实现脱节,避免后续误解。
- 风险: 无。


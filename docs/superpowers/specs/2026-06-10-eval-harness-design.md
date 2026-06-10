# 评测地基(Eval Harness)设计

**日期**:2026-06-10
**分支**:`eval-harness`(基于 `main`)
**子项目**:这是「AI 质量 + 工程最佳实践 + 本地数据可靠性」三件套里的 **第一块**(A)。后续 B(生成质量大修)、C(本地数据可靠性)各走独立 spec。

---

## 1. 背景与目标

`yaml-write`(创作 DNA 工坊)定位为**本地优先的自用工具**:浏览器内持久化、BYOK、密钥不落服务器、无服务器数据库。本次不改变这一定位。

四个 AI 生成环节(提取 DNA / 融合方向 / 补洞设定 / 开篇正文)目前**全部**让人不够满意,但缺乏客观度量——改 prompt 是凭感觉,改了 A 可能拖累 B,无法判断「到底变好没」。

**本子项目要回答一个问题**:

> 「我刚改的 prompt / 参数,让某个环节的产出**确实变好了还是变差了**?」——用可复现的分数代替凭感觉。

它是后续 B(系统性改 prompt)的**验证闭环地基**:没有它,B 就是蒙着改。

### In scope

- 度量 4 个生成环节的产出质量,各自一套量规。
- 两类信号:**确定性检查**(免费、客观)+ **LLM-as-judge 量规打分**(0–4 分多维度)。
- **A/B 对比**:同一夹具上「基线 prompt vs 候选 prompt」的逐维度分数差(带 ↑/↓)。

### 明确 Out of scope(防范围膨胀)

- **不测**拆章 / 编码检测 / 水印清洗——那是确定性、非 LLM 的,已由 `app/splitQuality.ts` 的黄金向量单测覆盖。
- **不测**后端硬化层(限流 / SSRF / 密钥脱敏)——那是安全,不是生成质量。
- **不并入** `npm test` / 默认 `unittest`——它花钱、非确定,是独立手动命令。
- **不做**线上 dashboard、统计显著性检验、历史趋势库(YAGNI;报告落本地文件即可)。
- **不新增**任何用户可见功能;不触碰前端 UI。

---

## 2. 关键事实(设计依据)

- 管线的**编排**(拆章、arc 窗口、map/reduce、抽样、并发、断点续跑)全在 **TypeScript 客户端**(`app/dnaEngine.ts` / `app/dnaRouting.ts`)。Python 后端只是**无状态单次端点**。
  → 评测脚本**不重写** TS 编排,只在**端点层**度量「prompt → 产出」。
- 7 个结构化端点中,仅 2 个已把 prompt 抽成纯函数(`build_scene_user_prompt`、`build_repair_prompts`);其余 5 个 prompt **内联**在 async 端点处理器里。共享常量 `ANTI_SLOP_CONSTRAINT` / `FOUR_LAYER_DNA_GUIDE` 与 `run_structured` 为模块级。
- 端点 I/O 形状见 `api/schemas.py`(Pydantic)。各端点输入即其请求体。
- 主力模型 = DeepSeek(OpenAI 兼容)。判官用 `deepseek-chat`(V3);`deepseek-reasoner`(R1)可能不支持结构化/工具调用,不当判官。
- 评测可由用户用真实 key 实时跑,也允许 agent 跑;接受少量 API 成本。
- 样本夹具:用户提供 `1508.txt`(GBK/GB18030 编码、约 8MB 的大长篇,走 `sampling` 路由)。

---

## 3. 架构

**形态**:一个独立的 Python 评测包,**进程内**复用后端真实 prompt 构造;judge 直连 DeepSeek。不起服务器、不走 HTTP。选型理由:测的是线上同一套 prompt(零漂移)、不用起服务、agent 可跑、天然贴合 B 的验证闭环。

### 3.1 前置重构(顺手改进,单独 commit)

把 5 个内联 prompt 抽成纯函数,集中到新文件 `api/prompts.py`:

```
build_book_direct_prompts(data: BookDirectInput)        -> (system, user)
build_arc_map_prompts(data: ArcMapInput)                -> (system, user)
build_book_reduce_prompts(data: BookReduceInput)        -> (system, user)
build_fusion_directions_prompts(data: FusionDirectionsInput) -> (system, user)
# 已存在的两个一并迁入:
build_repair_prompts(data: RepairSettingGapsInput)      -> (system, user)
build_scene_user_prompt(data: SceneTextInput)           -> str   # SSE,保留现签名
```

`api/index.py` 的端点处理器改为调用这些函数。**要求:行为逐字节等价**——`run_structured` 调用、`ANTI_SLOP_CONSTRAINT` / `FOUR_LAYER_DNA_GUIDE` 拼接顺序、`adversarialRules` 追加、`tone` 子句全部保持现状,仅把字符串拼装搬家。共享常量也迁入或从 `prompts.py` 引用,保持单一来源。

**收益**:端点与评测共用同一份 prompt(零漂移);prompt 变成可单测、可检视;B 子项目改 prompt 时改的是 `prompts.py` 的 builder,而非埋在 handler 里。

> 验证重构无回归:`python -m unittest discover api`(含现有 `test_scene_resume.py`)+ `npx tsc --noEmit`(后端无 TS,但确认前端 schema 同步未被牵动)+ 一次手动走查。

### 3.2 评测包目录

放在 `yaml-write/evals/`:

```
evals/
  __init__.py
  config.py          # 读环境变量(DEEPSEEK_API_KEY 等);判官模型/温度常量
  fixtures/
    captured/        # EVAL_CAPTURE 落盘的原始捕获(gitignore)
    golden/          # 人工挑选冻结的黄金夹具(committed,除版权原文外)
  cases/             # 每个环节的 case 定义(指向输入夹具 + 用哪套量规)
  rubrics/           # 各环节量规(维度 + 评分锚点),纯数据(带版本号)
  checks.py          # 确定性检查
  judge.py           # LLM-as-judge:构造判官 prompt、调 DeepSeek、解析分数
  runner.py          # 编排:跑 case → 缓存 → judge → 汇总
  report.py          # 生成 markdown/json 报告 + A/B diff
  cache/             # 产出 & 判官结果缓存(gitignore)
  reports/           # 运行报告输出(gitignore)
  cli.py             # python -m evals run / compare / show
  README.md
```

**依赖**:仅需 `openai`(后端已间接依赖 `instructor`→`openai`)。judge 用 OpenAI 兼容 SDK 直连 DeepSeek。如需独立环境,加一行 `evals/requirements.txt`。

---

## 4. Fixtures(评测集)与跨环节隔离

### 4.1 铁原则:冻结的黄金中间产物

**每个环节的输入是「冻结的黄金夹具」,不是上游环节的实时产出。** 否则评方向得分低时,分不清是方向 prompt 烂还是上游 DNA 卡烂。隔离开,才能定位问题。

| 环节 | 输入夹具(= 该端点请求体) | 怎么造 |
|---|---|---|
| 提取·direct | 净化后的截断书文(≤200k 字) | 捕获(见 4.2) |
| 提取·arc-map | 1 个 arc 窗口文本(title + content) | 捕获 2–3 个真实窗口 |
| 提取·reduce | 一组 `ChapterMapItem` 摘要 | 捕获 |
| 融合方向 | 冻结的黄金 DNA 卡(engineCard + skinSource + mode + freedom) | 人工挑一张好卡冻结;cross/self、freedom 开关各一例 |
| 补洞 | 冻结的某黄金方向的 4 块 + skeleton + themeSkin | 从黄金方向冻结 |
| 开篇正文 | 冻结的 `SceneTextInput`(黄金方向 + 场景) | 从黄金方向冻结 |

### 4.2 夹具捕获(不重写 TS 编排)

在后端加一个**环境变量门控的捕获模式** `EVAL_CAPTURE=1`:开启后,每个端点把**校验后的输入**(先经 `scrub_sensitive` 剥离 `apiKey`/`baseUrl`)写到 `evals/fixtures/captured/<endpoint>-<ts>.json`。

流程:用户开 `EVAL_CAPTURE=1` 后用 app 在样本书上正常走一遍管线 → 真实请求体自动落盘 → 人工挑出满意的,移入 `evals/fixtures/golden/` 并命名冻结。零手工复制 JSON、零 TS 重写、零密钥泄漏。

> 捕获模式默认关闭,对正常运行零影响;落盘代码包在 `if os.getenv("EVAL_CAPTURE")` 内。

### 4.3 两档大小控成本

- **小档**(默认):样本书前 ~15 万字 → 走 `direct`,提取评测 1 次调用。平时迭代用它。
- **大档**:完整 8MB 书 → 走 `sampling`。只在需要验证大书时偶尔跑。

### 4.4 版权

样本原文 `.txt` 与 `fixtures/captured/` 一律 **gitignore**(仅存本地)。提交进 git 的只有评测代码、量规、和派生的小摘要类黄金夹具(reduce 摘要、DNA 卡、方向——非原文)。原文截断夹具留本地。

---

## 5. 评分

### 5.1 确定性检查(`checks.py` —— 免费、永远先跑、硬门)

- schema 能否被对应 Pydantic 解析;
- 结构约束:方向恰好 3 条且字段非空;`structureSkeleton` 节拍数 ≥ 阈值;每个 beat 的 `function`/`summary` 非空;
- 长度边界:开篇正文 ≥ N 字;设定块非空;
- **反套路黑名单命中数**:复用 `ANTI_SLOP_CONSTRAINT` / `applyAntiSlopFallback` 的词表(如「空气突然安静了」);
- 占位符 / 偷懒检测:「无」刷屏、整段复读。

任一硬门失败 → case 直接标红,**不浪费 judge 调用**。

### 5.2 LLM-as-judge(`judge.py` + `rubrics/`)

- **判官** = `deepseek-chat`,**温度 0–0.2**,**结构化输出**(每维度 0–4 分 + 一句理由)。
- **量规带版本号**:改量规不会悄悄改变历史分(版本号进缓存键)。
- **参照引导**:评方向时把 `engineCard` 喂给判官(才能判「引擎贴合度」);评正文时把方向设定 + `tone` 喂给判官。
- **票数**:默认**单票**省钱;`--votes 3` 取**中位数**用于重要 A/B。

各环节量规(维度,各 0–4 分):

- **提取 DNA**:结构准确性 / 引擎·皮分离度 / 具象深度(非陈词滥调)/ 完整性(漏没漏关键转折)
- **融合方向**:新颖度(不落套路)/ 引擎贴合度(看 `transferNote` 是否真迁移骨架)/ 三向差异度 / 可写性·冲突张力
- **补洞**:断裂点定位是否真是漏洞 / 补丁自洽性 / 设定块相对补洞前是否变好
- **开篇正文**:文笔语感(非 AI 腔)/ 反套路 / 连贯可读 / 贴合方向设定与 `tone`

判官输出结构(每维度):`{"dimension": str, "score": 0..4, "reason": str}`,case 级再附整体一句话。

---

## 6. 缓存 / CLI / 报告 / A-B 对比

### 6.1 两层缓存(`evals/cache/`,gitignore)

- **产出缓存**:键 = `(endpoint, 渲染后 prompt 的 hash, 输入夹具 hash, model, temperature)`。改 judge 但没改 prompt → 不重跑生成;改 prompt → 键变 → 自动重跑该环节。
- **判官缓存**:键 = `(量规版本, 判官模型, 被评产出的 hash)`。

### 6.2 CLI(`python -m evals ...`)

- `run [--stage extract|directions|repair|prose|all] [--size small|full] [--votes N] [--no-cache] --label <名字>`
  跑 case,报告落 `evals/reports/<ts>-<label>.{json,md}`;**报告内存实际渲染的 system/user prompt**(A/B 时能看清改了哪句)。
- `compare <baseline-label> <candidate-label>` — 逐维度差值,带 ↑/↓ 和均分变化。
- `show <label>` — 漂亮打印某份报告。
- `--dry-run` — 只列将发起的调用与**预估次数**,不真调(跑 `full`/全量前先看)。

### 6.3 A/B 工作流(B 子项目天天用的闭环)

`run --label baseline` → 改 `api/prompts.py` 的 builder → `run --label candidate` → `compare baseline candidate` → 看分涨没涨、哪维涨。

### 6.4 报告格式

Markdown:每环节一张表(case × 维度分 + 确定性检查 ✅/❌ + 判官理由可折叠)+ 顶部汇总均分;同名 JSON 供 `compare` 机读。

---

## 7. 成本 · 密钥 · 安全

- **密钥**:`config.py` 只从环境变量 `DEEPSEEK_API_KEY`(或 gitignore 的 `.env`)读,**绝不硬编码、绝不进 git**,与 app「密钥不落服务器/不入库」铁律一致。
- **成本控制**:默认小档 + 单票 + 命中缓存 + 只跑点名环节;跑 `full`/全量前先 `--dry-run`。
- **安全**:`EVAL_CAPTURE` 落盘前剥离凭证(复用 `scrub_sensitive`);报告永不含 key。
- **隔离**:`evals/` 不被 `unittest`/`vitest` 收集,纯手动命令,不污染现有测试。
- **`.gitignore` 追加**:`evals/cache/`、`evals/reports/`、`evals/fixtures/captured/`、`evals/fixtures/**/*.txt`、`.env`。
- **行动项**:用户把贴进对话的 DeepSeek key 用完后,到控制台**轮换(重置)**。

---

## 8. 验收标准

1. `api/prompts.py` 抽取完成,端点行为无回归(`python -m unittest discover api` 全绿 + 手动走查一遍生成无异常)。
2. `EVAL_CAPTURE=1` 跑一遍 app 后,`evals/fixtures/captured/` 出现各端点请求体,且**不含**任何凭证字段。
3. 4 个环节各至少 1 个黄金 case,`python -m evals run --stage all --size small --label baseline` 能产出 markdown + json 报告。
4. 确定性检查能正确把一个人工构造的坏产出(缺字段/超短/命中黑名单)标红。
5. 改一处 prompt 后 `compare baseline candidate` 能显示逐维度 ↑/↓。
6. 全程无任何密钥进入 git 或报告文件。

---

## 9. 待协调 / 风险

- **判官噪声**:LLM-as-judge 有方差。缓解:低温 + 结构化 + 参照引导 + 重要对比用 `--votes 3` 中位数。本 spec 不追求绝对分,只追求**同一夹具上的相对可比**。
- **样本单一**:目前仅一本 GBK 大书。先用其小档 + 大档跑通;后续可补一本短篇覆盖 `direct`/`arc` 边界(留待 B 或扩充评测集时)。
- **重构边界**:`api/prompts.py` 抽取必须逐字节等价,否则会无声改动线上行为。以 `unittest` + 手动走查兜底。

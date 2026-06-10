# 评测地基(Eval Harness)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 yaml-write 四个 AI 生成环节建立一套可复现、可 A/B 对比的质量度量(确定性检查 + LLM-as-judge),作为后续 prompt 大修的验证地基。

**Architecture:** 先把后端内联 prompt 抽成 `api/prompts.py` 的纯函数(端点与评测共用,零漂移);再建独立 Python 包 `evals/`,进程内调用这些 builder + `run_structured` 跑产出,判官走 DeepSeek 打分,两层缓存 + CLI 出报告与 compare diff。夹具用后端 `EVAL_CAPTURE` 门控落盘真实请求体冻结而成。

**Tech Stack:** Python 3 / FastAPI / Pydantic / `instructor`+`openai`(已有);测试用 `unittest`(与现有后端测试一致);判官模型 `deepseek-chat`。

参考 spec:`docs/superpowers/specs/2026-06-10-eval-harness-design.md`

---

## 文件结构

**前置重构(Phase 1)**
- 新建 `api/prompts.py` — 所有 prompt 构造纯函数 + 共享常量 + 低级文本助手。无副作用、只依赖 `api.schemas` + 标准库。
- 改 `api/index.py` — 删除内联 prompt,改为 `from .prompts import ...` 并调用;重新导出供老测试。
- 新建 `api/test_prompts.py` — 钉住各 builder 的不变量(unittest)。

**评测包(Phase 2–7),全部在 `yaml-write/evals/`**
- `config.py` — 环境变量(`DEEPSEEK_API_KEY`/`base_url`/judge 模型温度)。
- `capture` 钩子 — 落在 `api/index.py`(Phase 2),由 `EVAL_CAPTURE` 门控。
- `checks.py` — 各环节确定性检查(纯函数)。
- `rubrics.py` — 各环节量规(纯数据 + 版本号)。
- `judge.py` — 构造判官 prompt、调 DeepSeek、解析分数(client 可注入,便于离线单测)。
- `cache.py` — 产出/判官两层缓存的键计算与读写(纯 + 文件)。
- `stages.py` — 4 个环节的「夹具 → 调用真实 builder + run_structured → 产出」适配器。
- `runner.py` — 编排:case → 缓存 → 生成 → 检查 → judge → 汇总。
- `report.py` — markdown/json 报告 + compare diff(纯)。
- `cli.py` + `__main__.py` — `run`/`compare`/`show`/`--dry-run`。
- `rubrics/`、`cases/`、`fixtures/golden/`、`fixtures/captured/`、`cache/`、`reports/` 目录。
- `test_*.py` — 各模块离线单测(用假 client / 假产出,零网络)。
- `README.md`。

---

## Phase 0 — 脚手架与隔离护栏

### Task 1: 建 evals 包骨架 + gitignore + config

**Files:**
- Create: `yaml-write/evals/__init__.py`(空)
- Create: `yaml-write/evals/config.py`
- Create: `yaml-write/evals/test_config.py`
- Modify: `yaml-write/.gitignore`(追加忽略项)
- Create: `yaml-write/evals/README.md`

- [ ] **Step 1: 追加 .gitignore**

在 `yaml-write/.gitignore` 末尾追加:
```
# eval harness
evals/cache/
evals/reports/
evals/fixtures/captured/
evals/fixtures/**/*.txt
.env
```

- [ ] **Step 2: 写失败测试 `evals/test_config.py`**

```python
import os
import unittest

from evals.config import load_config, EvalConfig


class ConfigTests(unittest.TestCase):
    def test_reads_api_key_from_env(self) -> None:
        os.environ["DEEPSEEK_API_KEY"] = "sk-test"
        cfg = load_config()
        self.assertEqual(cfg.api_key, "sk-test")
        self.assertIn("deepseek", cfg.base_url)
        self.assertEqual(cfg.judge_model, "deepseek-chat")

    def test_missing_key_raises(self) -> None:
        os.environ.pop("DEEPSEEK_API_KEY", None)
        with self.assertRaises(RuntimeError):
            load_config()
```

- [ ] **Step 3: 运行验证失败**

Run(从 `yaml-write/`):`python -m unittest evals.test_config -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'evals.config'`

- [ ] **Step 4: 写 `evals/config.py`**

```python
"""评测配置:只从环境变量读凭证,绝不硬编码、绝不进 git。"""
import os
from dataclasses import dataclass

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_JUDGE_MODEL = "deepseek-chat"
DEFAULT_GEN_MODEL = "deepseek-chat"


@dataclass(frozen=True)
class EvalConfig:
    api_key: str
    base_url: str
    judge_model: str
    judge_temperature: float
    gen_model: str
    gen_temperature: float


def load_config() -> EvalConfig:
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "缺少 DEEPSEEK_API_KEY 环境变量。请 export DEEPSEEK_API_KEY=... 后再跑评测。"
        )
    return EvalConfig(
        api_key=api_key,
        base_url=os.getenv("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL).strip(),
        judge_model=os.getenv("EVAL_JUDGE_MODEL", DEFAULT_JUDGE_MODEL).strip(),
        judge_temperature=float(os.getenv("EVAL_JUDGE_TEMP", "0.0")),
        gen_model=os.getenv("EVAL_GEN_MODEL", DEFAULT_GEN_MODEL).strip(),
        gen_temperature=float(os.getenv("EVAL_GEN_TEMP", "0.7")),
    )
```

- [ ] **Step 5: 运行验证通过**

Run:`python -m unittest evals.test_config -v`
Expected: PASS(2 tests)

- [ ] **Step 6: 写最小 README**

`evals/README.md`:
```markdown
# evals — yaml-write 评测地基

手动跑的质量度量。**不**并入 `npm test` / 默认 `unittest`(花钱、非确定)。

## 用法
    export DEEPSEEK_API_KEY=sk-xxx
    python -m evals run --stage all --size small --label baseline
    python -m evals compare baseline candidate
    python -m evals show baseline

离线单测(无网络):`python -m unittest discover evals`
```

- [ ] **Step 7: Commit**

```bash
git add evals/__init__.py evals/config.py evals/test_config.py evals/README.md .gitignore
git commit -m "feat(evals): 包骨架 + config(env 读 key) + gitignore"
```

---

## Phase 1 — 前置重构:抽 `api/prompts.py`

> 铁律:**逐字节等价**搬家。下列任务用「源行号 → 目标函数」的方式精确指认搬运内容,避免重打 prompt 文本引入漂移。每个任务后跑 `python -m unittest discover api -v` 钉住无回归。

### Task 2: 建 prompts.py,迁入共享常量 + 文本助手 + 3 个已有 builder

**Files:**
- Create: `yaml-write/api/prompts.py`
- Modify: `yaml-write/api/index.py`(删除被搬走的定义,改 import 并重新导出)

- [ ] **Step 1: 创建 `api/prompts.py`,把以下定义从 `api/index.py` 逐字节剪切过来**

搬运清单(源 = 当前 `api/index.py` 行号):
- 常量 `ANTI_SLOP_CONSTRAINT`(79–85)、`TONE_GUIDE`(89–94)、`NON_COLD_TONE_RELEASE`(95–98)、`FOUR_LAYER_DNA_GUIDE`(101–112)
- 与 prompt 拼装相关的上限常量:`MAX_SCENE_CONTEXT_CHARS`(65)、`MAX_REDUCE_INPUT_CHARS`(64)
- 文本助手 `sanitize_text`(316–318)、`trim_text_tail`(320–324)
- 纯 builder `build_scene_user_prompt`(327–359)、`build_tone_clause`(362–371)、`build_repair_prompts`(374–421)

`api/prompts.py` 顶部:
```python
"""Prompt 构造纯函数 + 共享常量。端点(api/index.py)与评测(evals/)共用,确保零漂移。
只依赖 api.schemas + 标准库,无副作用、不发网络、不碰凭证。"""
from typing import Optional

from api.schemas import (
    SceneTextInput,
    RepairSettingGapsInput,
)
```
然后粘贴上述常量与函数(原文不动)。`MAX_DIRECT_INPUT_CHARS`/`MAX_ARC_CONTENT_CHARS` 已在 `api/schemas.py`,prompts.py 用到时从 schemas 引入(Task 3 处理)。

- [ ] **Step 2: 在 `api/index.py` 删除上述定义,改为从 prompts 导入(并重新导出,保住老测试)**

在 `api/index.py` 顶部 import 区加入:
```python
from .prompts import (
    ANTI_SLOP_CONSTRAINT,
    TONE_GUIDE,
    NON_COLD_TONE_RELEASE,
    FOUR_LAYER_DNA_GUIDE,
    MAX_SCENE_CONTEXT_CHARS,
    MAX_REDUCE_INPUT_CHARS,
    sanitize_text,
    trim_text_tail,
    build_scene_user_prompt,
    build_tone_clause,
    build_repair_prompts,
)
```
删除这些符号在 index.py 中的原定义行。其余使用处不变(同名在命名空间内)。`api/test_scene_resume.py` 的 `from api.index import build_scene_user_prompt` 因重新导出仍有效。

- [ ] **Step 3: 运行后端全部单测验证无回归**

Run(从 `yaml-write/`):`python -m unittest discover api -v`
Expected: PASS(现有 `test_scene_resume` 全绿)

- [ ] **Step 4: 类型/构建快检**

Run:`python -c "import api.index"`
Expected: 无 ImportError(确认无循环导入)

- [ ] **Step 5: Commit**

```bash
git add api/prompts.py api/index.py
git commit -m "refactor(api): 抽 prompts.py — 共享常量/文本助手/3个已有builder,index 重新导出"
```

### Task 3: 抽 3 个提取 builder(direct / reduce / arc-map)

**Files:**
- Modify: `yaml-write/api/prompts.py`(新增 3 个 builder)
- Modify: `yaml-write/api/index.py`(3 个 handler 改调用)
- Create: `yaml-write/api/test_prompts.py`

- [ ] **Step 1: 先写失败测试 `api/test_prompts.py`**

```python
import unittest

from api.prompts import (
    build_book_direct_prompts,
    build_book_reduce_prompts,
    build_arc_map_prompts,
    FOUR_LAYER_DNA_GUIDE,
)
from api.schemas import BookDirectInput, BookReduceInput, ArcMapInput, ChapterMapItem


def _creds():
    return dict(apiKey="k", baseUrl="http://localhost:11434/v1", model="m", temperature=0.7)


class ExtractionPromptTests(unittest.TestCase):
    def test_direct_contains_guide_and_content(self) -> None:
        s, u = build_book_direct_prompts(
            BookDirectInput(novelName="书A", content="正文内容XYZ", **_creds())
        )
        self.assertIn(FOUR_LAYER_DNA_GUIDE, s)
        self.assertIn("正文内容XYZ", u)
        self.assertIn("书A", u)

    def test_reduce_builds_timeline(self) -> None:
        s, u = build_book_reduce_prompts(
            BookReduceInput(
                novelName="书B",
                mapSummaries=[ChapterMapItem(keyPlotTurns="转折K")],
                **_creds(),
            )
        )
        self.assertIn(FOUR_LAYER_DNA_GUIDE, s)
        self.assertIn("转折K", u)

    def test_arc_map_has_four_questions(self) -> None:
        s, u = build_arc_map_prompts(
            ArcMapInput(title="第1-5章", content="弧窗正文", **_creds())
        )
        self.assertIn("DNA 突变点", s)
        self.assertIn("弧窗正文", u)
        self.assertIn("第1-5章", u)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest api.test_prompts -v`
Expected: FAIL，`ImportError: cannot import name 'build_book_direct_prompts'`

- [ ] **Step 3: 在 `api/prompts.py` 新增 3 个 builder**

从 schemas 引入上限:在 prompts.py import 区加 `from api.schemas import BookDirectInput, BookReduceInput, ArcMapInput, MAX_DIRECT_INPUT_CHARS`(若 reduce/arc 输入类型未引入则一并加)。新增:
```python
def build_book_direct_prompts(data: BookDirectInput) -> tuple[str, str]:
    """整本直提 (system, user)。content 截断逻辑保留在 handler(它还要 sanitize+空检查)。"""
    content = trim_text_tail(data.content, MAX_DIRECT_INPUT_CHARS) if False else sanitize_text(data.content)
    if len(content) > MAX_DIRECT_INPUT_CHARS:
        content = content[:MAX_DIRECT_INPUT_CHARS]
    system = (
        "你是一个顶级的小说架构大师与叙事学者。下面给出一本小说接近完整的正文(可能为节选/截断)。"
        "请整体把握全书后," + FOUR_LAYER_DNA_GUIDE
    )
    user = f"小说名:{data.novelName or '(未命名)'}\n\n【小说正文】\n{content}"
    return system, user


def build_book_reduce_prompts(data: BookReduceInput) -> tuple[str, str]:
    """全书 reduce (system, user)。"""
    lines = []
    for idx, m in enumerate(data.mapSummaries):
        lines.append(
            f"第 {idx + 1} 章 | 设定:{m.worldviewUpdates} | 情节:{m.keyPlotTurns} | "
            f"角色:{m.characterDevelopments} | 风格:{m.styleObservations}"
        )
    timeline = "\n".join(lines)
    if len(timeline) > MAX_REDUCE_INPUT_CHARS:
        timeline = timeline[:MAX_REDUCE_INPUT_CHARS]
    system = (
        "你是一个顶级的小说架构大师与叙事学者。下面是这本小说全部章节/弧窗提炼出的 Map 摘要序列(按时间线排列)。"
        "请通过长上下文综合推理," + FOUR_LAYER_DNA_GUIDE
    )
    user = f"小说名:{data.novelName or '(未命名)'}\n\n章节/弧窗 Map 摘要序列:\n{timeline}"
    return system, user


def build_arc_map_prompts(data: ArcMapInput) -> tuple[str, str]:
    """弧窗 map (system, user)。content 截断/空检查保留在 handler。"""
    from api.schemas import MAX_ARC_CONTENT_CHARS
    title = sanitize_text(data.title)
    content = sanitize_text(data.content)
    if len(content) > MAX_ARC_CONTENT_CHARS:
        content = content[:MAX_ARC_CONTENT_CHARS]
    system = (
        "你是一个极其挑剔的文学分析编辑。下面是一段【连续章节区间】的正文(可能跨多章)。"
        "请对这段区间整体降维提炼,过滤对话、抒情、招式细节等冗余,只关注实质性的'DNA 突变点':\n"
        "1. 本区间新展现的底层设定、地图或规则?\n"
        "2. 主角的情感底线 / 核心动机 / 人际关系发生的不可逆变化?\n"
        "3. 本区间最核心的情节推力(含关键转折与爽点)?\n"
        "4. 本区间独特的遣词造句或叙事语调特征?\n"
        "用极度精炼、非情绪化的骨架语言回答,每项控制在 150 字内;某项无内容则填'无'。"
    )
    user = f"区间标识: {title}\n\n区间正文:\n{content}"
    return system, user
```
> 注:`build_book_direct_prompts` 第一行的 `if False` 笔误务必删去,直接 `content = sanitize_text(data.content)`。上面 system/user 文本逐字对照源 index.py 526–530 / 554–558 / 583–592,确保等价。

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest api.test_prompts -v`
Expected: PASS(3 tests)

- [ ] **Step 5: 改 3 个 handler 调用 builder(行为等价)**

`api/index.py` 的 `extract_book_reduce`:保留 `ensure_rate_limit`/sanitize/`validate_llm_creds`/`logger.info`,把 515–530 的 timeline+prompt 拼装替换为:
```python
    system_prompt, user_prompt = build_book_reduce_prompts(data)
```
(从 prompts 导入 `build_book_reduce_prompts`)。`extract_book_direct`:保留空检查与截断 logger,把 554–558 替换为 `system_prompt, user_prompt = build_book_direct_prompts(data)`。`extract_arc_map`:保留空检查 logger,把 583–592 替换为 `system_prompt, user_prompt = build_arc_map_prompts(data)`。三处 `from .prompts import` 补齐新符号。

- [ ] **Step 6: 运行后端全测 + 导入快检**

Run:`python -m unittest discover api -v && python -c "import api.index"`
Expected: PASS,无 ImportError

- [ ] **Step 7: Commit**

```bash
git add api/prompts.py api/index.py api/test_prompts.py
git commit -m "refactor(api): 抽 direct/reduce/arc-map 三个提取 builder + 单测"
```

### Task 4: 抽融合方向 builder + temperature 解析

**Files:**
- Modify: `yaml-write/api/prompts.py`
- Modify: `yaml-write/api/index.py`(`generate_fusion_directions` 改调用)
- Modify: `yaml-write/api/test_prompts.py`

- [ ] **Step 1: 追加失败测试**

在 `api/test_prompts.py` 追加:
```python
from api.prompts import build_fusion_directions_prompts, resolve_fusion_temperature
from api.schemas import FusionDirectionsInput, EngineCardInput, StructureBeatItem, SkinSourceInput


class FusionPromptTests(unittest.TestCase):
    def _engine(self):
        return EngineCardInput(
            novelName="骨架书",
            structureSkeleton=[StructureBeatItem(function="废柴受辱", summary="开局被欺")],
            pacingSyuzhet="先抑后扬",
        )

    def test_cross_branch_keeps_beats(self) -> None:
        s, u = build_fusion_directions_prompts(
            FusionDirectionsInput(engineCard=self._engine(),
                                  skinSource=SkinSourceInput(themeSkin="美食"),
                                  mode="cross", freedom=False, **_creds())
        )
        self.assertIn("换皮变题", s)
        self.assertIn("废柴受辱", u)

    def test_freedom_branch_differs(self) -> None:
        s, _ = build_fusion_directions_prompts(
            FusionDirectionsInput(engineCard=self._engine(), freedom=True, **_creds())
        )
        self.assertIn("灵感", s)

    def test_freedom_temperature_floor(self) -> None:
        d = FusionDirectionsInput(engineCard=self._engine(), freedom=True,
                                  apiKey="k", baseUrl="x", model="m", temperature=0.5)
        self.assertGreaterEqual(resolve_fusion_temperature(d), 0.9)
        d2 = FusionDirectionsInput(engineCard=self._engine(), freedom=False,
                                   apiKey="k", baseUrl="x", model="m", temperature=0.5)
        self.assertEqual(resolve_fusion_temperature(d2), 0.5)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest api.test_prompts -v`
Expected: FAIL，`ImportError: cannot import name 'build_fusion_directions_prompts'`

- [ ] **Step 3: 在 `api/prompts.py` 新增 builder + 温度解析**

新增(system/user 两分支文本逐字对照源 index.py 620–697;`mode`/`skin_block`/`extra`/`beats` 拼装一并搬入):
```python
from api.schemas import FusionDirectionsInput


def _fusion_parts(data: FusionDirectionsInput) -> tuple[str, str, str]:
    """复用源 handler 620–652 的 beats / skin_block / extra 拼装。"""
    engine = data.engineCard
    beats = "\n".join(
        f"- {b.function}:{b.summary}" for b in engine.structureSkeleton if (b.function or "").strip()
    ) or "(结构骨架为空)"
    skin = data.skinSource
    if skin and (skin.novelName or (skin.themeSkin or "").strip()):
        skin_block = (
            f"题材来源:{skin.novelName or '(口述)'}\n"
            f"题材世界观与意象:{skin.themeSkin or '(未提供,可据来源自行归纳)'}\n"
            f"参考文笔质感:{skin.proseStyle or '(无特别要求)'}"
        )
        if skin.userBrief and skin.userBrief.strip():
            skin_block += f"\n用户额外诉求:{skin.userBrief.strip()}"
    else:
        brief = (skin.userBrief.strip() if (skin and skin.userBrief) else "")
        skin_block = (
            "(自我裂变:无题材书,请基于用户口述/自由发挥另立一个与原书反差鲜明的新题材)\n"
            f"用户口述题材诉求:{brief or '(未指定,请自选一个反差鲜明的新题材)'}"
        )
    extra = ""
    if data.userCustomPrompt and data.userCustomPrompt.strip():
        extra += f"\n\n【用户自定义大方向】:{data.userCustomPrompt.strip()}"
    if data.adversarialRules and data.adversarialRules.strip():
        extra += f"\n\n【用户红队对抗规则(最高优先级,违反即重写)】:{data.adversarialRules.strip()}"
    if data.avoidDirections:
        avoid_lines = "\n".join(f"- {a.strip()}" for a in data.avoidDirections if (a or "").strip())
        if avoid_lines:
            extra += (
                "\n\n【已生成过的方向(必须明显避开:题材内核 / 核心机制 / 角色配置都要换,"
                "禁止换名雷同或换汤不换药)】:\n" + avoid_lines
            )
    return beats, skin_block, extra


def build_fusion_directions_prompts(data: FusionDirectionsInput) -> tuple[str, str]:
    """融合方向 (system, user)。freedom True/False 双分支,文本逐字对照源 handler。
    注:engineCard 必填校验留在 handler(返回 400)。"""
    engine = data.engineCard
    beats, skin_block, extra = _fusion_parts(data)
    if data.freedom:
        system = (
            "你是一位富于原创力的小说立项策划(学理:把 Propp 功能 / 类推迁移当作【灵感源】,而非模具)。"
            "任务:把【骨架引擎】的功能节拍仅当灵感调色板,产出 3 个真正原创、彼此迥异的开篇立项方向。\n"
            "原则:\n"
            "1. DNA 是灵感不是模具——可自由重组 / 增删 / 跳过 / 另起结构节拍,不必保留原书的节拍序列与顺序。\n"
            "2. 用户意图(想往哪写 / 口述题材 / 反套路约束)权重高于源书节拍;二者冲突时优先服从用户意图,大胆偏离源书。\n"
            "3. 3 个方向须采用迥异的核心创意(题材内核 / 主题 / 机制 / 主角配置都不同),禁止换名式雷同,也禁止三个都只是源书的近似重映射。\n"
            "4. 每个方向给出:title、concept(一句话核心冲突)、catalyst(催化变量及其质变)、"
            "worldviewBlock / protagonistBlock / antagonistBlock / narrativeTone(具体设定四块)、"
            "transferNote(一句话:从引擎借用了什么灵感、又如何大胆偏离 / 重组)。\n"
            "5. 设定四块要逻辑自洽、可支撑后续开篇正文;文风随题材自由生长、鼓励鲜明个性,不必压成统一冷腔。\n"
            "(文风提示:仍尽量避免「命运的齿轮」「那一刻」之类陈词滥调与空洞煽情,但不强制统一冷腔——优先贴合各自题材的鲜明文风。)"
        )
        user = (
            f"【可借用的引擎灵感(仅供参考,可自由取舍 / 重组 / 另起,非约束)】\n来源:{engine.novelName or '(未命名)'}\n"
            f"结构功能节拍:\n{beats}\n编排节奏参考:{engine.pacingSyuzhet or '(未提供)'}\n\n"
            f"【创作主轴(最高权重)与题材调色板】\n{skin_block}{extra}\n\n"
            "请以用户意图为主轴、引擎仅作灵感,产出 3 个真正原创、彼此迥异的开篇立项方向。"
        )
    else:
        system = (
            "你是一位精通「换皮变题」的小说迁移大师(学理:Propp 功能不变·角色可替换;Riedl『story analogues』类推迁移)。"
            "任务:把【骨架引擎】的功能节拍序列,逐一类推迁移到【新题材皮】,产出 3 个『形似神不似』的换皮嫁接方向。\n"
            "硬规则:\n"
            "1. 保持引擎的功能节拍序列与编排节奏不变——同一套结构骨架与爽点曲线,只换皮、不换骨。\n"
            "2. 把每个功能节拍重新具象化为新题材里的等价事件(角色 / 道具 / 场景 / 机制换皮,功能不变),严禁照抄原书的题材名词。\n"
            "3. 3 个方向必须采用显著不同的嫁接思路(如:题材直译 / 反转母题 / 杂交第三元素),彼此在题材与机制上明显区分,禁止换名式雷同。\n"
            "4. 每个方向给出:title、concept(一句话核心冲突)、catalyst(催化变量及其质变)、"
            "worldviewBlock / protagonistBlock / antagonistBlock / narrativeTone(换皮后的新书具体设定四块)、"
            "transferNote(一句话溯源:保留了引擎的哪条结构、替换成了什么题材皮)。\n"
            "5. 设定四块要逻辑自洽、可支撑后续开篇正文;narrativeTone 贴合新题材重新生成文笔,不照搬原书。\n"
            + ANTI_SLOP_CONSTRAINT
        )
        user = (
            f"【骨架引擎(迁移不变量)】\n来源:{engine.novelName or '(未命名)'}\n"
            f"结构功能节拍序列:\n{beats}\n编排节奏:{engine.pacingSyuzhet or '(未提供)'}\n\n"
            f"【新题材皮(替换目标)】\n{skin_block}{extra}\n\n"
            "请输出 3 个换皮嫁接方向。"
        )
    return system, user


def resolve_fusion_temperature(data: FusionDirectionsInput) -> float:
    """freedom 抬高 variation:temperature 下限 0.9(对照源 index.py 676)。"""
    if data.freedom:
        return min(1.5, max(data.temperature, 0.9))
    return data.temperature
```

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest api.test_prompts -v`
Expected: PASS

- [ ] **Step 5: 改 `generate_fusion_directions` handler 调用**

保留 `ensure_rate_limit`/sanitize/`validate_llm_creds`/engineCard 缺失 400 校验/`logger.info`。把 620–697 的拼装与温度计算替换为:
```python
    system_prompt, user_prompt = build_fusion_directions_prompts(data)
    temperature = resolve_fusion_temperature(data)
```
补 `from .prompts import build_fusion_directions_prompts, resolve_fusion_temperature`。

- [ ] **Step 6: 全测 + 导入快检**

Run:`python -m unittest discover api -v && python -c "import api.index"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add api/prompts.py api/index.py api/test_prompts.py
git commit -m "refactor(api): 抽 fusion-directions builder + resolve_fusion_temperature"
```

---

## Phase 2 — 夹具捕获(EVAL_CAPTURE)

### Task 5: 后端门控的请求体捕获

**Files:**
- Modify: `yaml-write/api/index.py`(加捕获助手 + 在结构化端点调用)
- Create: `yaml-write/api/test_capture.py`

- [ ] **Step 1: 写失败测试 `api/test_capture.py`**

```python
import json
import os
import tempfile
import unittest

from api.index import capture_fixture


class CaptureTests(unittest.TestCase):
    def test_disabled_by_default(self) -> None:
        os.environ.pop("EVAL_CAPTURE", None)
        with tempfile.TemporaryDirectory() as d:
            capture_fixture("extract-book-direct", {"content": "x", "apiKey": "sk-secret"}, base_dir=d)
            self.assertEqual(os.listdir(d), [])

    def test_writes_scrubbed_when_enabled(self) -> None:
        os.environ["EVAL_CAPTURE"] = "1"
        with tempfile.TemporaryDirectory() as d:
            capture_fixture("extract-book-direct", {"content": "x", "apiKey": "sk-secret", "baseUrl": "u"}, base_dir=d)
            files = os.listdir(d)
            self.assertEqual(len(files), 1)
            blob = json.loads(open(os.path.join(d, files[0]), encoding="utf-8").read())
            self.assertNotIn("sk-secret", json.dumps(blob))
            self.assertEqual(blob.get("apiKey", ""), "")
        os.environ.pop("EVAL_CAPTURE", None)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest api.test_capture -v`
Expected: FAIL，`ImportError: cannot import name 'capture_fixture'`

- [ ] **Step 3: 在 `api/index.py` 加 `capture_fixture`**

放在 `sanitize_text` 之后(它会用到 `scrub_sensitive`,已存在于 index.py)。`_capture_counter` 用进程内自增避免 `Date.now` 类不可用问题;文件名用计数器,不用时间戳。
```python
_capture_counter = 0


def capture_fixture(endpoint: str, payload: dict, base_dir: str = "evals/fixtures/captured") -> None:
    """EVAL_CAPTURE=1 时,把剥离凭证后的请求体落盘成夹具。默认关闭,对正常运行零影响。"""
    if not os.getenv("EVAL_CAPTURE"):
        return
    global _capture_counter
    _capture_counter += 1
    scrubbed = dict(payload)
    for k in ("apiKey", "baseUrl"):
        if k in scrubbed:
            scrubbed[k] = ""
    os.makedirs(base_dir, exist_ok=True)
    path = os.path.join(base_dir, f"{endpoint}-{_capture_counter:04d}.json")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(scrub_sensitive(json.dumps(scrubbed, ensure_ascii=False, indent=2)))
```
确认 `import os, json` 已在 index.py 顶部(若无则补)。

- [ ] **Step 4: 在 7 个结构化端点开头(`ensure_rate_limit` 之后)插入捕获调用**

每个 handler 加一行,例如 `extract_book_direct`:
```python
    capture_fixture("extract-book-direct", data.model_dump())
```
对 `extract-book-reduce`/`extract-arc-map`/`generate-fusion-directions`/`repair-setting-gaps`/`tweak-fusion-blocks`/`split-recommend` 同样加(端点名用各自路径尾段)。`stream-scene-text` 也加 `capture_fixture("stream-scene-text", data.model_dump())`。

- [ ] **Step 5: 运行验证通过 + 全测**

Run:`python -m unittest api.test_capture -v && python -m unittest discover api -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add api/index.py api/test_capture.py
git commit -m "feat(api): EVAL_CAPTURE 门控的请求体捕获(剥离凭证)"
```

---

## Phase 3 — 确定性检查

### Task 6: checks.py

**Files:**
- Create: `yaml-write/evals/checks.py`
- Create: `yaml-write/evals/test_checks.py`

- [ ] **Step 1: 写失败测试 `evals/test_checks.py`**

```python
import unittest

from evals.checks import (
    check_dna_card, check_directions, check_prose, CheckResult,
)


class ChecksTests(unittest.TestCase):
    def test_good_dna_card_passes(self) -> None:
        card = {
            "structureSkeleton": [{"function": f"f{i}", "summary": f"s{i}"} for i in range(6)],
            "pacingSyuzhet": "节奏", "themeSkin": "题材", "proseStyle": "文笔",
        }
        r = check_dna_card(card)
        self.assertTrue(r.passed, r.failures)

    def test_too_few_beats_fails(self) -> None:
        card = {"structureSkeleton": [{"function": "f", "summary": "s"}],
                "pacingSyuzhet": "p", "themeSkin": "t", "proseStyle": "ps"}
        self.assertFalse(check_dna_card(card).passed)

    def test_directions_must_be_three(self) -> None:
        self.assertFalse(check_directions({"directions": []}).passed)

    def test_prose_slop_blacklist_hit(self) -> None:
        r = check_prose("仿佛整个世界都安静了。" * 30)
        self.assertFalse(r.passed)
        self.assertTrue(any("套路" in f or "黑名单" in f for f in r.failures))

    def test_prose_too_short(self) -> None:
        self.assertFalse(check_prose("太短").passed)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_checks -v`
Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 写 `evals/checks.py`**

```python
"""确定性检查:免费、客观、永远先跑。任一硬门失败 → 不浪费 judge 调用。"""
from dataclasses import dataclass, field
from typing import Any

MIN_BEATS = 5
MIN_PROSE_CHARS = 200

# 与 api.prompts.ANTI_SLOP_CONSTRAINT 词表对齐(子集,纯检查用)。
SLOP_BLACKLIST = [
    "命运的齿轮", "那一刻", "逆天改命", "眼神变得坚定", "嘴角勾起一抹弧度",
    "仿佛整个世界都安静了", "空气仿佛凝固", "心中一紧", "缓缓睁开眼", "不知为何",
]


@dataclass
class CheckResult:
    passed: bool
    failures: list[str] = field(default_factory=list)
    slop_hits: int = 0


def _nonempty(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip())


def check_dna_card(card: dict) -> CheckResult:
    fails: list[str] = []
    beats = card.get("structureSkeleton") or []
    if len(beats) < MIN_BEATS:
        fails.append(f"结构节拍数 {len(beats)} < {MIN_BEATS}")
    for i, b in enumerate(beats):
        if not _nonempty(b.get("function")) or not _nonempty(b.get("summary")):
            fails.append(f"节拍[{i}] function/summary 空")
    for k in ("pacingSyuzhet", "themeSkin", "proseStyle"):
        if not _nonempty(card.get(k)):
            fails.append(f"{k} 空")
    return CheckResult(passed=not fails, failures=fails)


def check_directions(payload: dict) -> CheckResult:
    fails: list[str] = []
    dirs = payload.get("directions") or []
    if len(dirs) != 3:
        fails.append(f"方向数 {len(dirs)} != 3")
    for i, d in enumerate(dirs):
        for k in ("title", "concept", "worldviewBlock", "protagonistBlock",
                  "antagonistBlock", "narrativeTone", "transferNote"):
            if not _nonempty(d.get(k)):
                fails.append(f"方向[{i}].{k} 空")
    return CheckResult(passed=not fails, failures=fails)


def check_repair(payload: dict) -> CheckResult:
    fails: list[str] = []
    for k in ("worldviewBlock", "protagonistBlock", "antagonistBlock", "narrativeTone"):
        if not _nonempty(payload.get(k)):
            fails.append(f"{k} 空")
    return CheckResult(passed=not fails, failures=fails)


def check_prose(text: str) -> CheckResult:
    fails: list[str] = []
    text = text or ""
    if len(text) < MIN_PROSE_CHARS:
        fails.append(f"正文字数 {len(text)} < {MIN_PROSE_CHARS}")
    hits = sum(text.count(p) for p in SLOP_BLACKLIST)
    if hits:
        fails.append(f"反套路黑名单命中 {hits} 次")
    return CheckResult(passed=not fails, failures=fails, slop_hits=hits)
```

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_checks -v`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/checks.py evals/test_checks.py
git commit -m "feat(evals): 确定性检查(checks.py)"
```

---

## Phase 4 — 量规与判官

### Task 7: rubrics.py(纯数据 + 版本号)

**Files:**
- Create: `yaml-write/evals/rubrics.py`
- Create: `yaml-write/evals/test_rubrics.py`

- [ ] **Step 1: 写失败测试 `evals/test_rubrics.py`**

```python
import unittest
from evals.rubrics import RUBRICS, RUBRIC_VERSION


class RubricTests(unittest.TestCase):
    def test_four_stages_present(self) -> None:
        self.assertEqual(set(RUBRICS), {"extract", "directions", "repair", "prose"})

    def test_each_has_dimensions(self) -> None:
        for stage, r in RUBRICS.items():
            self.assertGreaterEqual(len(r["dimensions"]), 3, stage)
            for dim in r["dimensions"]:
                self.assertIn("key", dim)
                self.assertIn("desc", dim)

    def test_version_is_str(self) -> None:
        self.assertIsInstance(RUBRIC_VERSION, str)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_rubrics -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/rubrics.py`**

```python
"""各环节量规:维度 + 0-4 分锚点。改量规请同时升 RUBRIC_VERSION(进缓存键,避免悄改历史分)。"""

RUBRIC_VERSION = "v1"

_SCALE = "评分锚点:0=严重缺陷 1=较差 2=合格 3=良好 4=优秀。"

RUBRICS = {
    "extract": {
        "title": "DNA 提取",
        "dimensions": [
            {"key": "structure_accuracy", "desc": "结构骨架是否真实反映原书的功能节拍序列"},
            {"key": "engine_skin_separation", "desc": "①②是否题材中立可迁移,③④是否是可替换的题材皮"},
            {"key": "concreteness", "desc": "summary 是否具象克制、无陈词滥调,有信息量"},
            {"key": "completeness", "desc": "是否漏掉关键转折/爽点/设定"},
        ],
    },
    "directions": {
        "title": "融合方向",
        "dimensions": [
            {"key": "novelty", "desc": "是否新颖、不落套路、非源书近似重映射"},
            {"key": "engine_fit", "desc": "transferNote 是否真把骨架结构节拍迁移到新题材"},
            {"key": "diversity", "desc": "3 个方向在题材内核/机制/角色上是否彼此迥异"},
            {"key": "writability", "desc": "concept 是否有冲突张力、可支撑开篇"},
        ],
    },
    "repair": {
        "title": "补洞",
        "dimensions": [
            {"key": "gap_accuracy", "desc": "gaps 定位的是否真是逻辑断裂点"},
            {"key": "patch_coherence", "desc": "patch 是否让节拍在新题材自洽成立"},
            {"key": "block_quality", "desc": "补洞后的四块设定是否更自洽、可支撑开篇"},
        ],
    },
    "prose": {
        "title": "开篇正文",
        "dimensions": [
            {"key": "craft", "desc": "文笔语感是否自然、非 AI 腔"},
            {"key": "anti_slop", "desc": "是否避开陈词滥调与空洞煽情"},
            {"key": "coherence", "desc": "是否连贯可读、无断层"},
            {"key": "fit", "desc": "是否贴合方向设定四块与指定 tone"},
        ],
    },
}


def rubric_for(stage: str) -> dict:
    if stage not in RUBRICS:
        raise KeyError(f"未知环节:{stage}")
    return RUBRICS[stage]


def scale_text() -> str:
    return _SCALE
```

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_rubrics -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evals/rubrics.py evals/test_rubrics.py
git commit -m "feat(evals): 各环节量规 rubrics.py(带版本号)"
```

### Task 8: judge.py(client 可注入,离线测解析)

**Files:**
- Create: `yaml-write/evals/judge.py`
- Create: `yaml-write/evals/test_judge.py`

- [ ] **Step 1: 写失败测试 `evals/test_judge.py`(用假 client,零网络)**

```python
import json
import unittest

from evals.judge import build_judge_messages, parse_judge_json, judge_output, JudgeScore


class JudgeParseTests(unittest.TestCase):
    def test_build_messages_includes_rubric_dims(self) -> None:
        msgs = build_judge_messages("extract", produced={"pacingSyuzhet": "x"}, reference=None)
        joined = json.dumps(msgs, ensure_ascii=False)
        self.assertIn("structure_accuracy", joined)
        self.assertIn("0=", joined)  # 评分锚点

    def test_parse_valid_json(self) -> None:
        raw = '{"scores":[{"dimension":"craft","score":3,"reason":"好"}],"overall":"还行"}'
        parsed = parse_judge_json(raw)
        self.assertEqual(parsed[0].dimension, "craft")
        self.assertEqual(parsed[0].score, 3)

    def test_parse_strips_codefence(self) -> None:
        raw = '```json\n{"scores":[{"dimension":"craft","score":4,"reason":"r"}]}\n```'
        parsed = parse_judge_json(raw)
        self.assertEqual(parsed[0].score, 4)

    def test_judge_output_with_fake_client(self) -> None:
        class FakeResp:
            def __init__(self, content):
                self.choices = [type("C", (), {"message": type("M", (), {"content": content})()})()]

        class FakeClient:
            def __init__(self, content):
                self._c = content
                self.chat = type("Chat", (), {"completions": self})()
            def create(self, **kw):
                return FakeResp(self._c)

        client = FakeClient('{"scores":[{"dimension":"novelty","score":2,"reason":"一般"}],"overall":"o"}')
        scores = judge_output("directions", produced={"directions": []}, reference=None,
                              client=client, model="deepseek-chat", temperature=0.0)
        self.assertEqual(scores[0].score, 2)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_judge -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/judge.py`**

```python
"""LLM-as-judge:构造判官 prompt、调 DeepSeek(OpenAI 兼容)、解析结构化分数。
client 可注入,便于离线单测;低温 + 结构化 + 参照引导。"""
import json
import re
from dataclasses import dataclass
from typing import Any, Optional

from evals.rubrics import rubric_for, scale_text, RUBRIC_VERSION


@dataclass
class JudgeScore:
    dimension: str
    score: int
    reason: str


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def build_judge_messages(stage: str, produced: Any, reference: Optional[Any]) -> list[dict]:
    r = rubric_for(stage)
    dims = "\n".join(f"- {d['key']}: {d['desc']}" for d in r["dimensions"])
    ref_block = ""
    if reference is not None:
        ref_block = f"\n【参照(判断贴合度用)】\n{json.dumps(reference, ensure_ascii=False)}\n"
    system = (
        f"你是严格的中文小说质量评审。针对「{r['title']}」环节,按下列维度逐项打分。{scale_text()}\n"
        f"维度:\n{dims}\n"
        '只输出 JSON,形如:{"scores":[{"dimension":"<key>","score":<0-4整数>,"reason":"<一句话>"}],"overall":"<一句话总评>"}。'
        "不要输出 JSON 以外的任何内容。"
    )
    user = f"{ref_block}\n【待评产出】\n{json.dumps(produced, ensure_ascii=False)}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_judge_json(raw: str) -> list[JudgeScore]:
    cleaned = _FENCE.sub("", (raw or "").strip())
    obj = json.loads(cleaned)
    out = []
    for s in obj.get("scores", []):
        score = int(s.get("score", 0))
        score = max(0, min(4, score))
        out.append(JudgeScore(dimension=str(s.get("dimension", "")), score=score,
                              reason=str(s.get("reason", ""))))
    return out


def judge_output(stage: str, produced: Any, reference: Optional[Any], *,
                 client, model: str, temperature: float) -> list[JudgeScore]:
    messages = build_judge_messages(stage, produced, reference)
    resp = client.chat.completions.create(
        model=model, temperature=temperature, messages=messages,
        response_format={"type": "json_object"},
    )
    content = resp.choices[0].message.content
    return parse_judge_json(content)


def judge_votes(stage: str, produced: Any, reference: Optional[Any], *,
                client, model: str, temperature: float, votes: int = 1) -> list[JudgeScore]:
    """votes>1 时多次打分,逐维度取中位数。"""
    if votes <= 1:
        return judge_output(stage, produced, reference, client=client, model=model, temperature=temperature)
    runs = [judge_output(stage, produced, reference, client=client, model=model, temperature=temperature)
            for _ in range(votes)]
    by_dim: dict[str, list[int]] = {}
    reasons: dict[str, str] = {}
    for run in runs:
        for sc in run:
            by_dim.setdefault(sc.dimension, []).append(sc.score)
            reasons.setdefault(sc.dimension, sc.reason)
    out = []
    for dim, scores in by_dim.items():
        scores.sort()
        median = scores[len(scores) // 2]
        out.append(JudgeScore(dimension=dim, score=median, reason=reasons[dim]))
    return out
```
> `judge_output` 测试中的 FakeClient 把 `self.chat.completions.create` 指向自身的 `create`,与真实 `openai` 的 `client.chat.completions.create` 同形。

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_judge -v`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/judge.py evals/test_judge.py
git commit -m "feat(evals): LLM-as-judge(judge.py,client 可注入,支持多票中位数)"
```

---

## Phase 5 — 生成适配器、缓存、编排

### Task 9: cache.py(键计算 + 文件读写)

**Files:**
- Create: `yaml-write/evals/cache.py`
- Create: `yaml-write/evals/test_cache.py`

- [ ] **Step 1: 写失败测试 `evals/test_cache.py`**

```python
import tempfile
import unittest

from evals.cache import output_key, judge_key, Cache


class CacheTests(unittest.TestCase):
    def test_output_key_changes_with_prompt(self) -> None:
        k1 = output_key("extract", "PROMPT_A", "FIXHASH", "m", 0.7)
        k2 = output_key("extract", "PROMPT_B", "FIXHASH", "m", 0.7)
        self.assertNotEqual(k1, k2)

    def test_judge_key_changes_with_rubric_version(self) -> None:
        self.assertNotEqual(judge_key("v1", "m", "OUT"), judge_key("v2", "m", "OUT"))

    def test_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            c = Cache(d)
            self.assertIsNone(c.get("k1"))
            c.put("k1", {"a": 1})
            self.assertEqual(c.get("k1"), {"a": 1})
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_cache -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/cache.py`**

```python
"""两层缓存键 + 文件读写。键变即重算(改 prompt → output_key 变 → 重跑生成)。"""
import hashlib
import json
import os
from typing import Any, Optional


def _h(*parts: str) -> str:
    return hashlib.sha256(" ".join(parts).encode("utf-8")).hexdigest()[:32]


def hash_text(text: str) -> str:
    return _h(text)


def output_key(stage: str, rendered_prompt: str, fixture_hash: str, model: str, temperature: float) -> str:
    return "out-" + _h(stage, rendered_prompt, fixture_hash, model, f"{temperature:.3f}")


def judge_key(rubric_version: str, judge_model: str, produced_text: str) -> str:
    return "judge-" + _h(rubric_version, judge_model, produced_text)


class Cache:
    def __init__(self, base_dir: str):
        self.base_dir = base_dir
        os.makedirs(base_dir, exist_ok=True)

    def _path(self, key: str) -> str:
        return os.path.join(self.base_dir, f"{key}.json")

    def get(self, key: str) -> Optional[Any]:
        path = self._path(key)
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def put(self, key: str, value: Any) -> None:
        with open(self._path(key), "w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False, indent=2)
```

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_cache -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evals/cache.py evals/test_cache.py
git commit -m "feat(evals): 两层缓存键 + 文件缓存(cache.py)"
```

### Task 10: stages.py(夹具 → 真实 builder + run_structured → 产出)

**Files:**
- Create: `yaml-write/evals/stages.py`
- Create: `yaml-write/evals/test_stages.py`

- [ ] **Step 1: 写失败测试 `evals/test_stages.py`(只测纯部分:render_prompt)**

```python
import unittest
from evals.stages import render_prompt, STAGE_SPECS


class StagesTests(unittest.TestCase):
    def test_specs_cover_four_stages(self) -> None:
        self.assertEqual(set(STAGE_SPECS), {"extract", "directions", "repair", "prose"})

    def test_render_prompt_extract(self) -> None:
        fixture = {"novelName": "书", "content": "正文ABC",
                   "apiKey": "", "baseUrl": "", "model": "m", "temperature": 0.7}
        system, user = render_prompt("extract", fixture)
        self.assertIn("正文ABC", user)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_stages -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/stages.py`**

```python
"""各环节适配器:把黄金夹具(请求体 dict)喂给真实 builder 渲染 prompt,
再经 run_structured 生成产出。render_prompt 是纯函数(可离线测);generate_output 发网络。
extract 环节默认用 direct 路由(小档),夹具即截断书文。"""
from typing import Any

from api.prompts import (
    build_book_direct_prompts,
    build_fusion_directions_prompts,
    resolve_fusion_temperature,
    build_repair_prompts,
)
from api.schemas import (
    BookDirectInput, FusionDirectionsInput, RepairSettingGapsInput,
    NovelDNACardResponse, FusionDirectionsResponse, RepairSettingGapsResponse,
)


def _creds_into(fixture: dict, cfg) -> dict:
    d = dict(fixture)
    d["apiKey"] = cfg.api_key
    d["baseUrl"] = cfg.base_url
    d["model"] = cfg.gen_model
    return d


STAGE_SPECS = {
    "extract": {"input": BookDirectInput, "response": NovelDNACardResponse,
                "builder": build_book_direct_prompts},
    "directions": {"input": FusionDirectionsInput, "response": FusionDirectionsResponse,
                   "builder": build_fusion_directions_prompts},
    "repair": {"input": RepairSettingGapsInput, "response": RepairSettingGapsResponse,
               "builder": build_repair_prompts},
    # prose 走 SSE,产出是纯文本;单独处理(见 generate_output)。
    "prose": {"input": None, "response": None, "builder": None},
}


def render_prompt(stage: str, fixture: dict) -> tuple[str, str]:
    """纯渲染:夹具 → (system, user)。prose 环节用 build_scene_user_prompt(只有 user)。"""
    if stage == "prose":
        from api.prompts import build_scene_user_prompt
        from api.schemas import SceneTextInput
        data = SceneTextInput(**{**fixture, "apiKey": "x", "baseUrl": "x", "model": "m"})
        return "", build_scene_user_prompt(data)
    spec = STAGE_SPECS[stage]
    data = spec["input"](**{**fixture, "apiKey": "x", "baseUrl": "x", "model": "m"})
    return spec["builder"](data)


async def generate_output(stage: str, fixture: dict, cfg) -> dict:
    """发真实网络:经 run_structured 生成结构化产出,返回 model_dump() dict。
    prose 环节走 SSE,这里收齐全文返回 {'text': ...}。"""
    from api.index import run_structured
    payload = _creds_into(fixture, cfg)
    if stage == "prose":
        text = await _stream_prose(payload, cfg)
        return {"text": text}
    spec = STAGE_SPECS[stage]
    data = spec["input"](**payload)
    if stage == "directions":
        system, user = build_fusion_directions_prompts(data)
        temperature = resolve_fusion_temperature(data)
    else:
        system, user = spec["builder"](data)
        temperature = cfg.gen_temperature
    result = await run_structured(
        api_key=cfg.api_key, base_url=cfg.base_url, model=cfg.gen_model,
        response_model=spec["response"], system_prompt=system, user_prompt=user,
        temperature=temperature, request=_FakeRequest(), label=f"eval_{stage}",
    )
    return result.model_dump()


class _FakeRequest:
    """run_structured 只在出错日志里用 request 取 IP;提供最小桩。"""
    class _C:
        host = "eval"
    client = _C()
    headers: dict = {}
    url = type("U", (), {"path": "/eval"})()


async def _stream_prose(payload: dict, cfg) -> str:
    """直接复用 build_scene_user_prompt + 一次非流式 chat 收全文(评测无需逐字流)。"""
    import instructor  # noqa: F401 (确认依赖在)
    from api.prompts import build_scene_user_prompt, build_tone_clause, ANTI_SLOP_CONSTRAINT
    from api.index import build_openai_client
    from api.schemas import SceneTextInput
    data = SceneTextInput(**payload)
    user = build_scene_user_prompt(data)
    system = "你是一位顶尖的中文小说家。" + ANTI_SLOP_CONSTRAINT + build_tone_clause(data.tone)
    client = build_openai_client(cfg.api_key, cfg.base_url, timeout=120.0)
    resp = await client.chat.completions.create(
        model=cfg.gen_model, temperature=cfg.gen_temperature,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return resp.choices[0].message.content or ""
```
> 注:`_stream_prose` 的 system 文本须对照 `api/index.py` 的 `stream_scene_text`(772+)实际拼装核对一致(开篇 system 串 + ANTI_SLOP + tone 子句);执行本任务时打开该 handler 比对,保证与线上一致。

- [ ] **Step 4: 运行验证通过(只跑纯测)**

Run:`python -m unittest evals.test_stages -v`
Expected: PASS(2 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/stages.py evals/test_stages.py
git commit -m "feat(evals): 各环节适配器 stages.py(纯 render + 网络 generate)"
```

### Task 11: runner.py(编排 case → 缓存 → 生成 → 检查 → judge → 汇总)

**Files:**
- Create: `yaml-write/evals/runner.py`
- Create: `yaml-write/evals/cases.py`
- Create: `yaml-write/evals/test_runner.py`

- [ ] **Step 1: 写失败测试 `evals/test_runner.py`(注入假生成/假判官,零网络)**

```python
import asyncio
import tempfile
import unittest

from evals.runner import run_case, CaseSpec
from evals.judge import JudgeScore


class RunnerTests(unittest.TestCase):
    def test_run_case_skips_judge_on_hard_fail(self) -> None:
        async def fake_gen(stage, fixture, cfg):
            return {"directions": []}  # check_directions 会失败

        judged = {"called": False}
        def fake_judge(stage, produced, reference, **kw):
            judged["called"] = True
            return []

        with tempfile.TemporaryDirectory() as d:
            case = CaseSpec(name="dir1", stage="directions", fixture={}, reference=None)
            res = asyncio.run(run_case(case, cfg=_cfg(d), gen=fake_gen, judge=fake_judge, use_cache=False))
        self.assertFalse(res["checks"]["passed"])
        self.assertFalse(judged["called"])

    def test_run_case_judges_on_pass(self) -> None:
        async def fake_gen(stage, fixture, cfg):
            return {"directions": [_good_dir() for _ in range(3)]}
        def fake_judge(stage, produced, reference, **kw):
            return [JudgeScore("novelty", 3, "ok")]
        with tempfile.TemporaryDirectory() as d:
            case = CaseSpec(name="dir2", stage="directions", fixture={}, reference=None)
            res = asyncio.run(run_case(case, cfg=_cfg(d), gen=fake_gen, judge=fake_judge, use_cache=False))
        self.assertTrue(res["checks"]["passed"])
        self.assertEqual(res["scores"][0]["score"], 3)


def _good_dir():
    return {k: "x" for k in ("title", "concept", "worldviewBlock", "protagonistBlock",
                             "antagonistBlock", "narrativeTone", "transferNote")}

def _cfg(d):
    from evals.config import EvalConfig
    return EvalConfig(api_key="k", base_url="b", judge_model="m", judge_temperature=0.0,
                      gen_model="m", gen_temperature=0.7)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_runner -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/cases.py` 与 `evals/runner.py`**

`evals/cases.py`:
```python
"""Case 装载:从 evals/cases/<stage>/*.json 读黄金夹具与可选参照。
每个 case 文件形如 {"fixture": {...请求体...}, "reference": {...可选...}}。"""
import json
import os
from dataclasses import dataclass
from typing import Any, Optional

CASES_DIR = os.path.join(os.path.dirname(__file__), "cases")


@dataclass
class CaseSpec:
    name: str
    stage: str
    fixture: dict
    reference: Optional[Any] = None


def load_cases(stage: str) -> list[CaseSpec]:
    stage_dir = os.path.join(CASES_DIR, stage)
    if not os.path.isdir(stage_dir):
        return []
    out = []
    for fn in sorted(os.listdir(stage_dir)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(stage_dir, fn), encoding="utf-8") as fh:
            blob = json.load(fh)
        out.append(CaseSpec(name=fn[:-5], stage=stage,
                            fixture=blob["fixture"], reference=blob.get("reference")))
    return out
```

`evals/runner.py`:
```python
"""编排单个 case:渲染 prompt → (缓存)生成 → 确定性检查 → (通过才)judge → 汇总。"""
import json
from typing import Any, Callable

from evals.cases import CaseSpec
from evals.checks import check_dna_card, check_directions, check_repair, check_prose, CheckResult
from evals.stages import render_prompt, generate_output
from evals.judge import judge_votes, JudgeScore
from evals.cache import Cache, output_key, judge_key, hash_text
from evals.rubrics import RUBRIC_VERSION

_CHECK_FN = {
    "extract": lambda o: check_dna_card(o),
    "directions": lambda o: check_directions(o),
    "repair": lambda o: check_repair(o),
    "prose": lambda o: check_prose(o.get("text", "")),
}


def _check(stage: str, output: dict) -> CheckResult:
    return _CHECK_FN[stage](output)


async def run_case(case: CaseSpec, *, cfg, gen: Callable = generate_output,
                   judge: Callable = None, use_cache: bool = True,
                   cache_dir: str = "evals/cache", votes: int = 1) -> dict:
    system, user = render_prompt(case.stage, case.fixture)
    rendered = system + "\n----\n" + user
    fixture_hash = hash_text(json.dumps(case.fixture, ensure_ascii=False, sort_keys=True))
    cache = Cache(cache_dir) if use_cache else None

    okey = output_key(case.stage, rendered, fixture_hash, cfg.gen_model, cfg.gen_temperature)
    output = cache.get(okey) if cache else None
    if output is None:
        output = await gen(case.stage, case.fixture, cfg)
        if cache:
            cache.put(okey, output)

    chk = _check(case.stage, output)
    result = {
        "name": case.name, "stage": case.stage,
        "rendered_prompt": rendered,
        "output": output,
        "checks": {"passed": chk.passed, "failures": chk.failures},
        "scores": [],
        "overall": None,
    }
    if not chk.passed:
        return result  # 硬门失败 → 不浪费 judge

    judge_fn = judge or _default_judge
    produced_text = json.dumps(output, ensure_ascii=False, sort_keys=True)
    jkey = judge_key(RUBRIC_VERSION, cfg.judge_model, produced_text)
    cached_scores = cache.get(jkey) if cache else None
    if cached_scores is not None:
        result["scores"] = cached_scores
        return result

    scores = judge_fn(case.stage, output, case.reference,
                      client=_judge_client(cfg), model=cfg.judge_model,
                      temperature=cfg.judge_temperature, votes=votes)
    result["scores"] = [{"dimension": s.dimension, "score": s.score, "reason": s.reason} for s in scores]
    if cache:
        cache.put(jkey, result["scores"])
    return result


def _default_judge(stage, produced, reference, *, client, model, temperature, votes=1):
    return judge_votes(stage, produced, reference, client=client, model=model,
                       temperature=temperature, votes=votes)


def _judge_client(cfg):
    from api.index import build_openai_client
    return build_openai_client(cfg.api_key, cfg.base_url, timeout=60.0)
```
> 测试通过 `judge=` 注入假判官并 `use_cache=False`,故 `_judge_client`/网络不被触达。

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_runner -v`
Expected: PASS(2 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/runner.py evals/cases.py evals/test_runner.py
git commit -m "feat(evals): case 装载 + 编排 runner(缓存/硬门短路/judge)"
```

---

## Phase 6 — 报告与 CLI

### Task 12: report.py(markdown/json + compare diff)

**Files:**
- Create: `yaml-write/evals/report.py`
- Create: `yaml-write/evals/test_report.py`

- [ ] **Step 1: 写失败测试 `evals/test_report.py`**

```python
import unittest
from evals.report import to_markdown, diff_reports


def _report(label, score):
    return {"label": label, "cases": [
        {"name": "c1", "stage": "directions",
         "checks": {"passed": True, "failures": []},
         "scores": [{"dimension": "novelty", "score": score, "reason": "r"}],
         "rendered_prompt": "P", "output": {}}
    ]}


class ReportTests(unittest.TestCase):
    def test_markdown_has_stage_and_score(self) -> None:
        md = to_markdown(_report("baseline", 3))
        self.assertIn("directions", md)
        self.assertIn("novelty", md)

    def test_diff_shows_delta(self) -> None:
        d = diff_reports(_report("baseline", 2), _report("candidate", 4))
        self.assertIn("novelty", d)
        self.assertIn("+2", d)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_report -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/report.py`**

```python
"""报告生成与 A/B diff。markdown 给人看,json 给 compare 机读。"""
import json
from collections import defaultdict


def _avg(scores: list[dict]) -> float:
    return sum(s["score"] for s in scores) / len(scores) if scores else 0.0


def to_markdown(report: dict) -> str:
    lines = [f"# 评测报告:{report['label']}", ""]
    for case in report["cases"]:
        lines.append(f"## [{case['stage']}] {case['name']}")
        ck = case["checks"]
        lines.append(f"- 确定性检查:{'✅' if ck['passed'] else '❌ ' + '; '.join(ck['failures'])}")
        if case["scores"]:
            lines.append(f"- 均分:{_avg(case['scores']):.2f}")
            lines.append("")
            lines.append("| 维度 | 分 | 理由 |")
            lines.append("|---|---|---|")
            for s in case["scores"]:
                lines.append(f"| {s['dimension']} | {s['score']} | {s['reason']} |")
        lines.append("")
        lines.append("<details><summary>渲染 prompt</summary>\n\n```\n" + case["rendered_prompt"] + "\n```\n</details>")
        lines.append("")
    return "\n".join(lines)


def _index(report: dict) -> dict:
    out = {}
    for case in report["cases"]:
        for s in case["scores"]:
            out[(case["name"], s["dimension"])] = s["score"]
    return out


def diff_reports(baseline: dict, candidate: dict) -> str:
    bi, ci = _index(baseline), _index(candidate)
    keys = sorted(set(bi) | set(ci))
    lines = [f"# A/B 对比:{baseline['label']} → {candidate['label']}", "",
             "| case | 维度 | 基线 | 候选 | Δ |", "|---|---|---|---|---|"]
    for name, dim in keys:
        b = bi.get((name, dim))
        c = ci.get((name, dim))
        if b is None or c is None:
            delta = "n/a"
        else:
            d = c - b
            arrow = "↑" if d > 0 else ("↓" if d < 0 else "→")
            delta = f"{'+' if d > 0 else ''}{d}{arrow}"
        lines.append(f"| {name} | {dim} | {b if b is not None else '-'} | {c if c is not None else '-'} | {delta} |")
    return "\n".join(lines)


def save_report(report: dict, path_no_ext: str) -> tuple[str, str]:
    md_path, json_path = path_no_ext + ".md", path_no_ext + ".json"
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(to_markdown(report))
    return md_path, json_path
```

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_report -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evals/report.py evals/test_report.py
git commit -m "feat(evals): 报告 markdown/json + A/B diff(report.py)"
```

### Task 13: cli.py(run/compare/show/--dry-run)

**Files:**
- Create: `yaml-write/evals/cli.py`
- Create: `yaml-write/evals/__main__.py`
- Create: `yaml-write/evals/test_cli.py`

- [ ] **Step 1: 写失败测试 `evals/test_cli.py`**

```python
import unittest
from evals.cli import build_parser, plan_calls


class CliTests(unittest.TestCase):
    def test_parser_run(self) -> None:
        args = build_parser().parse_args(["run", "--stage", "directions", "--label", "x"])
        self.assertEqual(args.cmd, "run")
        self.assertEqual(args.stage, "directions")

    def test_dry_run_counts(self) -> None:
        # 2 个 directions case,单票 → 预计 2 次生成 + 2 次 judge
        plan = plan_calls(stages=["directions"], case_counts={"directions": 2}, votes=1)
        self.assertEqual(plan["generate"], 2)
        self.assertEqual(plan["judge"], 2)
```

- [ ] **Step 2: 运行验证失败**

Run:`python -m unittest evals.test_cli -v`
Expected: FAIL

- [ ] **Step 3: 写 `evals/cli.py` 与 `evals/__main__.py`**

`evals/cli.py`:
```python
"""命令行:run / compare / show / --dry-run。"""
import argparse
import asyncio
import json
import os

from evals.config import load_config
from evals.cases import load_cases
from evals.runner import run_case
from evals.report import save_report, to_markdown, diff_reports

ALL_STAGES = ["extract", "directions", "repair", "prose"]
REPORTS_DIR = os.path.join(os.path.dirname(__file__), "reports")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="evals")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--stage", default="all", choices=ALL_STAGES + ["all"])
    r.add_argument("--size", default="small", choices=["small", "full"])
    r.add_argument("--votes", type=int, default=1)
    r.add_argument("--no-cache", action="store_true")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--label", required=True)
    c = sub.add_parser("compare")
    c.add_argument("baseline")
    c.add_argument("candidate")
    s = sub.add_parser("show")
    s.add_argument("label")
    return p


def plan_calls(stages: list[str], case_counts: dict, votes: int) -> dict:
    gen = sum(case_counts.get(s, 0) for s in stages)
    judge = gen * max(1, votes)
    return {"generate": gen, "judge": judge}


def _stages_for(stage: str) -> list[str]:
    return ALL_STAGES if stage == "all" else [stage]


def _load_json(label: str) -> dict:
    with open(os.path.join(REPORTS_DIR, f"{label}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def cmd_run(args) -> None:
    stages = _stages_for(args.stage)
    case_counts = {s: len(load_cases(s)) for s in stages}
    if args.dry_run:
        plan = plan_calls(stages, case_counts, args.votes)
        print(f"[dry-run] stages={stages} cases={case_counts} "
              f"预计生成 {plan['generate']} 次 + judge {plan['judge']} 次调用")
        return
    cfg = load_config()
    os.makedirs(REPORTS_DIR, exist_ok=True)
    all_cases = [c for s in stages for c in load_cases(s)]

    async def _go():
        out = []
        for case in all_cases:
            print(f"... 跑 [{case.stage}] {case.name}")
            out.append(await run_case(case, cfg=cfg, use_cache=not args.no_cache, votes=args.votes))
        return out

    cases = asyncio.run(_go())
    report = {"label": args.label, "cases": cases}
    md, js = save_report(report, os.path.join(REPORTS_DIR, args.label))
    print(f"报告已写:{md}\n           {js}")


def cmd_compare(args) -> None:
    print(diff_reports(_load_json(args.baseline), _load_json(args.candidate)))


def cmd_show(args) -> None:
    print(to_markdown(_load_json(args.label)))


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    {"run": cmd_run, "compare": cmd_compare, "show": cmd_show}[args.cmd](args)
```

`evals/__main__.py`:
```python
from evals.cli import main

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 运行验证通过**

Run:`python -m unittest evals.test_cli -v`
Expected: PASS

- [ ] **Step 5: dry-run 冒烟(无网络)**

Run:`python -m evals run --stage all --label probe --dry-run`
Expected: 打印 `[dry-run] ...`(case 数此时多为 0,正常)

- [ ] **Step 6: Commit**

```bash
git add evals/cli.py evals/__main__.py evals/test_cli.py
git commit -m "feat(evals): CLI run/compare/show + --dry-run"
```

---

## Phase 7 — 播种黄金夹具 + 端到端验收

### Task 14: 捕获并冻结黄金夹具,跑通真实 baseline

> 本任务有手动步骤(用真实 key 跑 app + 挑夹具),非纯自动。

- [ ] **Step 1: 准备样本(小档)**

把用户提供的 `1508.txt` 放到本地(勿提交)。在 app 里导入它;若想要小档,导入后只取前 ~15 万字(或直接用整本走 sampling——任意,先有真实请求体即可)。

- [ ] **Step 2: 开捕获跑一遍管线**

```bash
cd yaml-write
EVAL_CAPTURE=1 npm run dev
```
在浏览器里对样本完整走一遍:提取 DNA → 生成方向 → 选方向(触发补洞)→ 写开篇。完成后 `evals/fixtures/captured/` 应出现各端点请求体 JSON。

- [ ] **Step 3: 校验捕获文件不含凭证**

Run:`grep -ri "sk-" evals/fixtures/captured/ || echo "clean"`
Expected: 打印 `clean`(无任何 key)

- [ ] **Step 4: 冻结成 case**

为每个环节挑 1 个满意的请求体,转成 case 文件(包上 `{"fixture": {...}, "reference": ...}`):
- `evals/cases/extract/case1.json` — fixture = 某个 `extract-book-direct` 请求体(小档)。reference 省略。
- `evals/cases/directions/case1.json` — fixture = `generate-fusion-directions` 请求体;reference = 该请求体里的 `engineCard`(供判官判贴合度)。
- `evals/cases/repair/case1.json` — fixture = `repair-setting-gaps` 请求体。
- `evals/cases/prose/case1.json` — fixture = `stream-scene-text` 请求体(去掉 `currentDraft`/`resumeFromText` 以评全新开篇);reference = 其 `selectedDirection`。

每个 case 文件示例骨架:
```json
{
  "fixture": { "novelName": "...", "content": "...", "temperature": 0.7 },
  "reference": null
}
```

- [ ] **Step 5: dry-run 看调用预估**

Run:`python -m evals run --stage all --size small --label baseline --dry-run`
Expected: `预计生成 4 次 + judge 4 次调用`(各环节 1 case,单票)

- [ ] **Step 6: 真实跑 baseline**

```bash
export DEEPSEEK_API_KEY=sk-xxx   # 用户自己的 key
python -m evals run --stage all --size small --label baseline
```
Expected: 逐 case 打印进度,最终写出 `evals/reports/baseline.md` + `.json`;打开 md 应见 4 环节的维度分与判官理由。

- [ ] **Step 7: 验证确定性检查能抓坏产出**

临时把某 case 的 fixture 改成会产出过短正文/缺字段的输入,或手动构造一个坏 output 单测;确认 `checks.passed=false` 且未触发 judge(已由 `test_runner` 覆盖,此处肉眼复核报告里 ❌ 行)。

- [ ] **Step 8: 验证 A/B**

改 `api/prompts.py` 里某 builder 一句话(如 direct 的 system 开头),`python -m evals run --stage extract --label candidate`,再 `python -m evals compare baseline candidate`。Expected: 打印逐维度 Δ(↑/↓)。改回 builder。

- [ ] **Step 9: 提交 case 与文档(不含原文/报告/缓存)**

```bash
git add evals/cases/
git commit -m "test(evals): 播种四环节黄金 case + 端到端跑通 baseline"
```
确认 `git status` 中 `evals/cache/`、`evals/reports/`、`evals/fixtures/captured/`、`*.txt` 均被忽略、未入暂存。

---

## 验收标准(对照 spec §8)

1. `api/prompts.py` 抽取完成,`python -m unittest discover api -v` 全绿(含 `test_scene_resume`、`test_prompts`、`test_capture`)。
2. `EVAL_CAPTURE=1` 跑一遍 app 后,`evals/fixtures/captured/` 出现各端点请求体,`grep -ri "sk-"` 为 clean。
3. 4 环节各 ≥1 黄金 case,`python -m evals run --stage all --size small --label baseline` 产出 md+json。
4. 确定性检查能把坏产出标红且短路 judge(`test_runner` + 报告复核)。
5. `compare baseline candidate` 显示逐维度 ↑/↓。
6. 全程无密钥进入 git 或报告(`.gitignore` 生效 + 捕获剥离凭证 + 报告不含 key)。
7. `python -m unittest discover evals -v` 全绿且零网络(所有网络路径靠注入/手动命令)。

---

## 自查记录(writing-plans Self-Review)

- **Spec 覆盖**:§3.1 重构→Task 2-4;§4.2 捕获→Task 5;§5.1 检查→Task 6;§5.2 量规/judge→Task 7-8;§6.1 缓存→Task 9;§6.2 CLI→Task 13;§6.3 A/B→Task 14 Step 8;§6.4 报告→Task 12;§7 安全→Task 1(gitignore)+Task 5(剥离)。无遗漏。
- **占位符**:无 TBD/TODO;阈值(MIN_BEATS=5、MIN_PROSE_CHARS=200)已给具体值;两处「执行时对照源 handler 核对」是 prose system 串与重构等价性的**人工校验要求**,非代码占位。
- **类型一致**:`CaseSpec`/`CheckResult`/`JudgeScore`/`EvalConfig` 跨任务签名一致;`run_structured` 调用参数对照源签名(443-456);`build_*_prompts` 返回 `(str, str)`、`resolve_fusion_temperature` 返回 `float`,与调用处一致。
- **已知执行注意**:Task 3 Step 3 的 `if False` 是反面示例,已显式要求删除;Task 10 `_stream_prose` 与 Task 14 prose case 须对照线上 `stream_scene_text` 的 system 拼装核对一致。

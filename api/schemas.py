from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Literal

# 自适应提取：整本直提（小档）与弧窗（中/大档）的输入上限。
MAX_DIRECT_INPUT_CHARS = 200000
MAX_ARC_CONTENT_CHARS = 48000

# ============================================================
# 阶段一：弧窗 / 单章 Map 摘要（extract-arc-map 的 response_model）
# ============================================================
class ChapterMapSummaryResponse(BaseModel):
    worldviewUpdates: str = Field(..., description="本章新展现的底层设定规则、地图、力量体系变化。若无，请写'无'。")
    keyPlotTurns: str = Field(..., description="本章发生的重大情节转折、核心矛盾进展（两句话以内）。")
    characterDevelopments: str = Field(..., description="本章涉及角色的内心变化、新动机或新关系（极简白描）。")
    styleObservations: str = Field(..., description="本章独特的遣词造句或叙事语调特征。")


# ============================================================
# 阶段二：全书 DNA 卡片 (Reduce / Direct) — v2 四层「引擎 / 皮」模型
# 引擎层（①②）结构化、可干净迁移；皮层（③④）自由文本、可替换。
# 与 app/db.ts 的 StructureBeat / NovelDNACard 逐字段同步（camelCase）。
# ============================================================
class StructureBeat(BaseModel):
    function: str = Field(..., description="可迁移的功能节拍 / 角色功能（Propp 功能；如「废柴受辱」「获得金手指」「打脸打压者」）")
    summary: str = Field(..., description="该功能节拍在原书中的具体体现（一句话，具象、克制、无陈词滥调）")


class NovelDNACardResponse(BaseModel):
    structureSkeleton: List[StructureBeat] = Field(..., min_length=1, description="① 引擎·结构骨架：可迁移的功能节拍序列（结构化）")
    pacingSyuzhet: str = Field(..., description="② 引擎·编排节奏：视角排布 / 悬念铺陈 / 爽点曲线（syuzhet 表层叙事编排）")
    themeSkin: str = Field(..., description="③ 皮·题材：题材类型 / 世界观底层规则与代价 / 核心意象（可替换的自由文本）")
    proseStyle: str = Field(..., description="④ 文笔：语感、语言颗粒度、白描/意象风格（换皮时默认贴新题材重生成）")


class ChapterMapItem(BaseModel):
    worldviewUpdates: str = ""
    keyPlotTurns: str = ""
    characterDevelopments: str = ""
    styleObservations: str = ""


class BookReduceInput(BaseModel):
    novelName: str = Field("", max_length=300)
    mapSummaries: List[ChapterMapItem] = Field(..., min_length=1)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# 小档「整本直提」：整本（或大块）净化文本一次喂入 → 直接产 4 层 DNA（跳过逐章 map）。
class BookDirectInput(BaseModel):
    novelName: str = Field("", max_length=300)
    content: str = Field(..., min_length=1, max_length=MAX_DIRECT_INPUT_CHARS)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# 中/大档「弧窗 map」：若干连续章节拼接成弧文本 → 一条 ChapterMapSummary（上限高于单章）。
class ArcMapInput(BaseModel):
    title: str = Field(..., min_length=1, max_length=600)
    content: str = Field(..., min_length=1, max_length=MAX_ARC_CONTENT_CHARS)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段三：创意融合方向（3 个绝对不同的原创方向）
# ============================================================
class FusionDirection(BaseModel):
    title: str = Field(..., description="变体创意方向标题")
    concept: str = Field(..., description="核心变体创意理念（一句话震撼人心的冲突描述）")
    catalyst: str = Field(..., description="注入的催化变量及其产生的质变")
    worldviewBlock: str = Field(..., description="换皮后的新书世界观设定")
    protagonistBlock: str = Field(..., description="换皮后的新书主角设定")
    antagonistBlock: str = Field(..., description="换皮后的新书对手/阻碍设定")
    narrativeTone: str = Field(..., description="新书的文本风格基调建议")
    transferNote: str = Field(..., description="换皮溯源：一句话说明本方向如何把骨架引擎的结构节拍嫁接到新题材（类推迁移说明：保留了哪条引擎结构、替换成了什么题材皮）")


class FusionDirectionsResponse(BaseModel):
    directions: List[FusionDirection] = Field(..., min_length=3, max_length=3)


# v2 换皮迁移（角色制）输入：指认「哪本骨架(引擎) / 哪本题材(皮)」——engineCard 为骨架，skinSource 为题材皮 / 口述。
class StructureBeatItem(BaseModel):
    function: str = ""
    summary: str = ""


class EngineCardInput(BaseModel):
    """骨架书的引擎层（①结构 + ②编排）——迁移的「不变量」。"""
    novelName: str = ""
    structureSkeleton: List[StructureBeatItem] = Field(default_factory=list)
    pacingSyuzhet: str = ""


class SkinSourceInput(BaseModel):
    """题材来源：交叉融合取题材书的 ③④层；自我裂变留空 novelName，由 userBrief 口述新题材。"""
    novelName: str = ""
    themeSkin: str = ""
    proseStyle: str = ""
    userBrief: str = ""


class FusionDirectionsInput(BaseModel):
    # 换皮迁移·角色制：engineCard 为骨架，skinSource 为题材皮 / 口述。
    engineCard: Optional[EngineCardInput] = None
    skinSource: Optional[SkinSourceInput] = None
    mode: Optional[str] = Field(None, pattern="^(self|cross)$")
    # 0→1 原创模式开关（与 mode:self/cross 正交）：True=松绑「节拍不变」、DNA 当灵感调色板、用户意图压过源书节拍；False=换皮变题（默认，逐字保持现状）。
    freedom: bool = Field(False, description="True 走 0→1 原创 / 自由重组分支；False（默认）走换皮变题分支。")
    userCustomPrompt: Optional[str] = Field(None, max_length=2000)
    adversarialRules: Optional[str] = Field(None, max_length=2000)
    # 候选池：再生成时把已有方向（title：concept）喂回，提示模型避开雷同（方向页候选池·去重）。
    avoidDirections: List[str] = Field(default_factory=list, max_length=40)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段三点二：补洞（gap-repair）——质量护城河
# 逐结构节拍核对新题材能否支撑，定位断裂点并补入自洽事件/设定（Riedl：朴素迁移不保证自洽）。
# ============================================================
class RepairGap(BaseModel):
    beat: str = Field(..., description="撑不住的结构节拍 / 功能")
    issue: str = Field(..., description="新题材下该节拍的逻辑断裂点")
    patch: str = Field(..., description="补入的自洽事件 / 设定（使该节拍在新题材成立）")


class RepairSettingGapsResponse(BaseModel):
    worldviewBlock: str = Field(..., description="补洞后的新书世界观设定")
    protagonistBlock: str = Field(..., description="补洞后的新书主角设定")
    antagonistBlock: str = Field(..., description="补洞后的新书对手设定")
    narrativeTone: str = Field(..., description="补洞后的叙事色调")
    gaps: List[RepairGap] = Field(default_factory=list, description="本次定位并补入的断裂点清单（供展示「补了什么」）")


class RepairSettingGapsInput(BaseModel):
    worldviewBlock: str = ""
    protagonistBlock: str = ""
    antagonistBlock: str = ""
    narrativeTone: str = ""
    structureSkeleton: List[StructureBeatItem] = Field(default_factory=list)
    themeSkin: str = ""
    # 与 generate-fusion-directions 的 freedom 对齐：True=0→1 原创，补洞只查方向自身自洽、不拉回源书结构骨架；False=换皮，逐节拍核对源结构能否被新题材支撑。
    freedom: bool = Field(False, description="True 走原创补洞分支（查内部自洽）；False（默认）走换皮补洞分支（核对源结构支撑）。")
    adversarialRules: Optional[str] = Field(None, max_length=2000)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段三点五：全局 Command 调整（仅返回被修改的积木）
# ============================================================
class TweakBlocksResponse(BaseModel):
    modifiedBlocks: List[str] = Field(..., description="发生修改的积木 ID：worldviewBlock/protagonistBlock/antagonistBlock/narrativeTone")
    worldviewBlock: Optional[str] = None
    protagonistBlock: Optional[str] = None
    antagonistBlock: Optional[str] = None
    narrativeTone: Optional[str] = None


class TweakBlocksInput(BaseModel):
    worldviewBlock: str = ""
    protagonistBlock: str = ""
    antagonistBlock: str = ""
    narrativeTone: str = ""
    targetBlock: Optional[str] = Field(None, pattern="^(worldviewBlock|protagonistBlock|antagonistBlock|narrativeTone)$")
    userInstruction: str = Field(..., min_length=1, max_length=2000)
    adversarialRules: Optional[str] = Field(None, max_length=2000)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段四 & 五：分镜故事板 / 分镜正文
# ============================================================
class SelectedDirection(BaseModel):
    title: str = ""
    worldviewBlock: str = ""
    protagonistBlock: str = ""
    antagonistBlock: str = ""
    narrativeTone: str = ""


class StoryboardScene(BaseModel):
    sceneNumber: int = Field(..., description="场景序号")
    sceneTitle: str = Field(..., description="场景标题")
    plotOutline: str = Field(..., description="本场景核心情节走向及爽点/爆点")
    tensionLevel: str = Field(..., description="张力曲线（如：低开高走、情绪爆发、悬疑冷场）")
    visualCues: str = Field(..., description="画面感与环境意象指示")


class ActiveCardItem(BaseModel):
    name: str = ""
    type: Literal["worldview", "character", "prop", "geography", ""] = ""
    summary: str = ""
    details: str = ""
    activeState: Literal["sceneActive", "globalActive", "idle", ""] = ""


class SceneTextInput(BaseModel):
    selectedDirection: SelectedDirection
    currentScene: StoryboardScene
    precedingTexts: Dict[int, str] = Field(default_factory=dict)
    activeCards: List[ActiveCardItem] = Field(default_factory=list)
    currentDraft: Optional[str] = Field(None, max_length=24000)
    resumeFromText: Optional[str] = Field(None, max_length=24000)
    adversarialRules: Optional[str] = Field(None, max_length=2000)
    # 文风寄存器预设键（cold/hot/humor/lyrical）；缺省=贴题材默认。对抗 ANTI_SLOP 把各题材压成统一冷腔。
    tone: Optional[str] = Field(None, max_length=40)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段 1.5：JIT 智能语义拆分推荐（分章失败的巨型单章 → 推荐裁切点）
# 注：沿用本文件既有约定——字段直接手写 camelCase，不用 alias_generator。
# ============================================================
MAX_SPLIT_RECOMMEND_PARAGRAPHS = 4000


class SplitRecommendation(BaseModel):
    splitParagraphIndex: int = Field(
        ...,
        ge=0,
        description="建议在该自然段“之后”切分；0 基索引，对应传入 paragraphs 列表的下标。",
    )
    suggestedTitle: str = Field(..., description="切分出的“下半章”推荐标题（简洁、具体、贴合内容）。")
    reason: str = Field(..., description="为何建议在此切分（一句话，具象、克制、无陈词滥调）。")


class SplitRecommendResponse(BaseModel):
    recommendations: List[SplitRecommendation] = Field(
        default_factory=list,
        description="推荐裁切点列表，按段落先后顺序排列；若无明显语义边界则返回空列表。",
    )


class SplitRecommendInput(BaseModel):
    paragraphs: List[str] = Field(..., min_length=1, max_length=MAX_SPLIT_RECOMMEND_PARAGRAPHS)
    novelName: str = Field("", max_length=300)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段五点二：后端 Pydantic 质检三把锁与评估报告 (Story 3.2)
# ============================================================
class SceneEvaluateInput(BaseModel):
    sceneId: str = Field(..., description="场景 ID")
    attempt: int = Field(..., description="评估尝试次数/轮次")
    draft: str = Field(..., min_length=1, max_length=24000, description="待审计生成的场景草稿")
    selectedDirection: SelectedDirection = Field(..., description="选定的融合创作方向设定")
    currentScene: StoryboardScene = Field(..., description="当前所处场景大纲信息")
    activeCards: List[ActiveCardItem] = Field(default_factory=list, description="激活的角色设定、世界观卡片列表")
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


class GateResult(BaseModel):
    passed: bool = Field(..., description="该项检验是否通过")
    reason: str = Field(..., description="未通过的具体原因/审核意见，若通过则为空字符串")


class SceneAuditResult(BaseModel):
    styleLock: GateResult = Field(..., description="风格锁校验结果")
    consistencyLock: GateResult = Field(..., description="人设锁校验结果")
    outlineLock: GateResult = Field(..., description="大纲锁校验结果")
    actionableFeedback: str = Field(..., description="如果不通过，给出供写手 Agent 迭代的修改指令，全部通过则为空字符串")


class SceneEvaluateResponse(BaseModel):
    sceneId: str = Field(..., description="场景 ID")
    attempt: int = Field(..., description="尝试次数/轮次")
    passed: bool = Field(..., description="三重拦截是否整体通过")
    failedGates: List[str] = Field(..., description="失败的锁名称列表，例如 ['StyleLock', 'ConsistencyLock', 'OutlineLock']")
    evidence: str = Field(..., description="质检未通过的具体违规证据/原文引用与分析")
    actionableFeedback: str = Field(..., description="综合修复反馈/对写手的修改指令，全通过则为空字符串")

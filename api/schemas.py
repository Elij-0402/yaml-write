from pydantic import BaseModel, Field
from typing import List, Optional, Dict

MAX_CHAPTER_CONTENT_CHARS = 30000

# ============================================================
# 阶段一：单章 Map 提取
# ============================================================
class ChapterMapSummaryResponse(BaseModel):
    worldviewUpdates: str = Field(..., description="本章新展现的底层设定规则、地图、力量体系变化。若无，请写'无'。")
    keyPlotTurns: str = Field(..., description="本章发生的重大情节转折、核心矛盾进展（两句话以内）。")
    characterDevelopments: str = Field(..., description="本章涉及角色的内心变化、新动机或新关系（极简白描）。")
    styleObservations: str = Field(..., description="本章独特的遣词造句或叙事语调特征。")


class ChapterMapInput(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    content: str = Field(..., min_length=1, max_length=MAX_CHAPTER_CONTENT_CHARS)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


# ============================================================
# 阶段二：全书 DNA 卡片 (Reduce)
# ============================================================
class NovelDNACardResponse(BaseModel):
    theme: str = Field(..., description="底层母题与核心冲突（充满张力与文学隐喻的表述）")
    worldview: str = Field(..., description="世界观底层运行规则与代价体系（逻辑自洽且深刻）")
    characters: str = Field(..., description="核心角色灵魂原型（刻画其矛盾性与致命缺陷）")
    narrativeStyle: str = Field(..., description="叙事结构特征与视角排布规律")
    styleFingerprint: str = Field(..., description="文字指纹（如：语言颗粒度、冷白描特征、意象风格）")


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


# ============================================================
# 阶段三：创意融合方向（3 个绝对不同的原创方向）
# ============================================================
class FusionDirection(BaseModel):
    title: str = Field(..., description="变体创意方向标题")
    concept: str = Field(..., description="核心变体创意理念（一句话震撼人心的冲突描述）")
    catalyst: str = Field(..., description="注入的催化变量及其产生的质变")
    worldviewBlock: str = Field(..., description="融合与重塑后的世界观设定")
    protagonistBlock: str = Field(..., description="融合与重塑后的主角设定")
    antagonistBlock: str = Field(..., description="融合与重塑后的对手/阻碍设定")
    narrativeTone: str = Field(..., description="全新的文本风格基调建议")


class FusionDirectionsResponse(BaseModel):
    directions: List[FusionDirection] = Field(..., min_length=3, max_length=3)


class DNACardItem(BaseModel):
    novelName: str = ""
    theme: str = ""
    worldview: str = ""
    characters: str = ""
    narrativeStyle: str = ""
    styleFingerprint: str = ""


class FusionDirectionsInput(BaseModel):
    dnaCards: List[DNACardItem] = Field(..., min_length=1)
    userCustomPrompt: Optional[str] = Field(None, max_length=2000)
    adversarialRules: Optional[str] = Field(None, max_length=2000)
    fusionBias: float = Field(0.5, ge=0.01, le=0.99)
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


class StoryboardResponse(BaseModel):
    scenes: List[StoryboardScene] = Field(...)


class StoryboardInput(BaseModel):
    selectedDirection: SelectedDirection
    sceneCount: int = Field(3, ge=1, le=8)
    adversarialRules: Optional[str] = Field(None, max_length=2000)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(0.7, ge=0.0, le=1.5)


class SceneTextInput(BaseModel):
    selectedDirection: SelectedDirection
    currentScene: StoryboardScene
    precedingTexts: Dict[int, str] = Field(default_factory=dict)
    currentDraft: Optional[str] = Field(None, max_length=24000)
    resumeFromText: Optional[str] = Field(None, max_length=24000)
    adversarialRules: Optional[str] = Field(None, max_length=2000)
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

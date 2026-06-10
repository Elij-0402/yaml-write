"""Prompt 构造纯函数 + 共享常量。端点(api/index.py)与评测(evals/)共用,确保零漂移。
只依赖 api.schemas + 标准库,无副作用、不发网络、不碰凭证。"""
from typing import Optional

from api.schemas import SceneTextInput, RepairSettingGapsInput

# prompt 拼装相关的上限常量(从 index.py 迁入)。
MAX_REDUCE_INPUT_CHARS = 200000
MAX_SCENE_CONTEXT_CHARS = 24000

# 反 AI 套路硬约束（各创作 prompt 复用）
ANTI_SLOP_CONSTRAINT = (
    "【反 AI 套路硬约束】严禁出现陈词滥调与空洞煽情，包括但不限于："
    "“命运的齿轮”“那一刻”“逆天改命”“眼神变得坚定”“嘴角勾起一抹弧度”“仿佛整个世界都安静了”"
    "“空气仿佛凝固”“心中一紧”“缓缓睁开眼”“不知为何”等。"
    "禁止宏大空泛的抒情与解释性旁白；改用冰冷、具象、高信息密度的物理细节与克制白描，"
    "让冲突通过动作、环境与器物呈现，而非作者直接告知。文字要有颗粒度与刺痛感。"
)

# 文风寄存器（成稿 prose 用）：对抗 ANTI_SLOP 把各题材都压成统一「冷峻法医腔」的同质化。
# 选了非冷峻寄存器时，附上 NON_COLD_TONE_RELEASE：保留「禁陈词滥调」的硬约束，但放开「统一冷腔」的压平。
TONE_GUIDE = {
    "cold": "本篇文风寄存器：冷峻克制——物理细节、克制白描、零煽情。",
    "hot": "本篇文风寄存器：热血爽快——节奏明快、爽点张扬、情绪有冲击力；但仍避免空喊口号与陈词滥调。",
    "humor": "本篇文风寄存器：幽默轻快——机锋、反差与节奏感；但不滑向油滑段子或网络梗堆砌。",
    "lyrical": "本篇文风寄存器：抒情细腻——意象与情绪自然流动；但避免空泛宏大的抒情套话与无信息量的辞藻。",
}
NON_COLD_TONE_RELEASE = (
    "（注意：本篇请贴合上述文风寄存器，不要强行压成统一的冷峻法医腔；"
    "上面的反套路约束仍然有效——禁陈词滥调与空洞煽情，但允许该寄存器应有的温度与色彩。）"
)

# 4 层「引擎 / 皮」DNA 产出规范（extract-book-direct 与 extract-book-reduce 共用，确保两路输出同形）。
FOUR_LAYER_DNA_GUIDE = (
    "请把这本小说拆解为「可移植引擎」与「可替换皮」，输出 4 层创作 DNA"
    "（换皮变题理论：迁移引擎、替换皮 → 形似神不似的新书）：\n"
    "① structureSkeleton（引擎·结构骨架）：可迁移的【功能节拍序列】（Propp 功能 / 角色功能）。"
    "每个节拍含 function（功能名，须题材中立，如「废柴受辱」「获得金手指」「打脸打压者」「强敌登场」「绝境翻盘」）"
    "与 summary（该节拍在本书的具体体现，一句话）。按故事推进顺序给出约 8–20 个关键节拍，"
    "只保留可被任意题材复用的【结构功能】，剥离具体题材名词。\n"
    "② pacingSyuzhet（引擎·编排节奏）：视角排布、悬念与信息差的铺陈方式、爽点/钩子的出现节奏与曲线（syuzhet 表层编排）。\n"
    "③ themeSkin（皮·题材）：题材类型、世界观底层运行规则与代价体系、核心意象与符号——这是【可替换】的那层皮。\n"
    "④ proseStyle（文笔）：语言颗粒度、白描/意象风格、句式与语调质感。\n"
    "铁律：引擎层（①②）必须题材中立、可干净迁移；皮层（③④）才承载具体题材。"
)


def sanitize_text(value: str) -> str:
    return value.strip()


def trim_text_tail(value: str, max_chars: int) -> str:
    normalized = sanitize_text(value)
    if len(normalized) <= max_chars:
        return normalized
    return normalized[-max_chars:]


def build_scene_user_prompt(data: SceneTextInput) -> str:
    d = data.selectedDirection
    scene = data.currentScene

    ordered = sorted(data.precedingTexts.items())
    preceding = "\n\n".join(text for _, text in ordered if text and text.strip())
    preceding = trim_text_tail(preceding, MAX_SCENE_CONTEXT_CHARS)
    preceding_block = preceding if preceding.strip() else "（这是开篇第一个分镜，无前文。）"

    current_draft_raw = data.currentDraft or data.resumeFromText or ""
    current_draft = trim_text_tail(current_draft_raw, MAX_SCENE_CONTEXT_CHARS)
    resume_block = ""
    resume_instruction = "请紧密承接前置分镜最后一句话的语气、环境与角色站位，继续创作当前分镜。"
    if current_draft:
        resume_block = (
            f"\n【当前分镜已生成正文（不要重复）】\n"
            f"----- 当前分镜草稿（续写基线） -----\n{current_draft}\n-------------------\n"
        )
        resume_instruction = (
            "请严格从“当前分镜草稿”的最后一句继续接写，延续语气、角色站位与环境细节。"
            "严禁复述草稿中已出现的句段。"
        )

    return (
        f"【角色设定与世界观积木】\n世界观：{d.worldviewBlock}\n主角：{d.protagonistBlock}\n"
        f"对手：{d.antagonistBlock}\n叙事色调：{d.narrativeTone}\n\n"
        f"【当前要写作的分镜】\n标题：{scene.sceneTitle}\n情节走向：{scene.plotOutline}\n"
        f"张力：{scene.tensionLevel}\n画面意象：{scene.visualCues}\n\n"
        f"【前置分镜已写出的实际正文（供承上启下）】\n----- 前情回顾 -----\n{preceding_block}\n-------------------\n"
        f"{resume_block}"
        f"{resume_instruction}"
        "严禁剧情断层或设定漂移。直接开始输出正文，不要重复前文。"
    )


def build_tone_clause(tone: Optional[str]) -> str:
    """文风寄存器 → 追加到成稿 prose system prompt 的子句（纯函数，可单测）。
    空/None=贴题材默认（无子句）；已知 key 用 TONE_GUIDE；非 cold 再追加放开统一冷腔的释放语。"""
    tone_key = (tone or "").strip()
    if not tone_key:
        return ""
    clause = "\n" + TONE_GUIDE.get(tone_key, f"本篇文风寄存器：{tone_key}。")
    if tone_key != "cold":
        clause += "\n" + NON_COLD_TONE_RELEASE
    return clause


def build_repair_prompts(data: RepairSettingGapsInput) -> tuple[str, str]:
    """补洞 (system, user) 提示词（纯函数，可单测）。
    freedom=True：只查方向自身自洽、绝不拉回源结构；False：逐节拍核对源结构能否被新题材支撑。"""
    beats = "\n".join(
        f"- {b.function}：{b.summary}" for b in data.structureSkeleton if (b.function or "").strip()
    ) or "（结构骨架为空）"
    adv = ""
    if data.adversarialRules and data.adversarialRules.strip():
        adv = f"\n【用户红队对抗规则（必须遵守）】：{data.adversarialRules.strip()}"

    if data.freedom:
        # 0→1 原创补洞：方向允许自由重组、不必忠于原结构 → 只查这套设定【自身】自洽，绝不拉回源书结构骨架。
        system = (
            "你是原创设定的『自洽质检官』。下面是一个 0→1 原创方向的四块设定——它从某个骨架获得灵感，"
            "但允许自由重组，并不必忠于原结构。请只检查这套设定【自身】是否逻辑自洽、足以支撑一个开篇：\n"
            "1. 定位内部矛盾 / 悬空未交代的设定 / 主角或对手缺失的动机与代价。\n"
            "2. 为每个断裂点补入让其自洽的事件 / 设定 / 机制，并写进对应的设定块。\n"
            "3. 只做『补洞』式增补与微调：不要把设定拉回任何原书结构、不要更换题材方向、不要删除既有合理设定。\n"
            "返回补洞后的四块设定，以及 gaps（beat 填该断裂点简称 / issue / patch）。"
            + adv
            + ANTI_SLOP_CONSTRAINT
        )
        user = (
            f"【灵感来源的结构节拍（仅供参考，不要求逐一对应，可忽略）】\n{beats}\n\n"
            f"【题材方向】\n{data.themeSkin or '（未提供）'}\n\n"
            f"【当前新书设定四块】\nworldviewBlock：{data.worldviewBlock}\nprotagonistBlock：{data.protagonistBlock}\n"
            f"antagonistBlock：{data.antagonistBlock}\nnarrativeTone：{data.narrativeTone}\n\n"
            "请只针对这套设定自身补洞（不要拉回原结构），返回完整的四块设定与 gaps 清单。"
        )
    else:
        system = (
            "你是换皮迁移的『补洞质检官』。朴素的结构迁移常留下逻辑硬伤——新题材撑不起原结构的某些功能节拍。\n"
            "请逐一核对【引擎结构节拍】在【新书设定】下能否自洽成立：\n"
            "1. 定位撑不住的节拍（例：『吞噬异火升级』迁到美食题材后没有对应的升级机制）。\n"
            "2. 为每个断裂点补入让逻辑自洽的事件 / 设定 / 机制，并写进对应的设定块。\n"
            "3. 只做『补洞』式增补与微调：不要推翻方向、不要更换题材、不要删除既有合理设定。\n"
            "返回补洞后的四块设定，以及 gaps（你定位并补入的断裂点清单：beat / issue / patch）。"
            + adv
            + ANTI_SLOP_CONSTRAINT
        )
        user = (
            f"【引擎结构功能节拍序列（必须都被新题材支撑）】\n{beats}\n\n"
            f"【新题材皮】\n{data.themeSkin or '（未提供）'}\n\n"
            f"【当前新书设定四块】\nworldviewBlock：{data.worldviewBlock}\nprotagonistBlock：{data.protagonistBlock}\n"
            f"antagonistBlock：{data.antagonistBlock}\nnarrativeTone：{data.narrativeTone}\n\n"
            "请补洞并返回完整的四块设定与 gaps 清单。"
        )
    return system, user

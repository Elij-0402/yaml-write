"""Prompt 构造纯函数 + 共享常量。端点(api/index.py)与评测(evals/)共用,确保零漂移。
只依赖 api.schemas + 标准库,无副作用、不发网络、不碰凭证。"""
from typing import Optional

from api.schemas import (
    SceneTextInput,
    RepairSettingGapsInput,
    BookDirectInput,
    BookReduceInput,
    ArcMapInput,
    FusionDirectionsInput,
    SceneEvaluateInput,
    ChatAssistantInput,
    ChatMessage,
    EntityCardUpdate,
    VolumeItem,
    ChapterItem,
    SceneItem,
    MAX_DIRECT_INPUT_CHARS,
    MAX_ARC_CONTENT_CHARS,
)

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

    active_cards_block = ""
    scene_active_list = []
    global_active_list = []

    if hasattr(data, "activeCards") and data.activeCards:
        type_map = {
            "worldview": "世界规章",
            "character": "人物",
            "prop": "道具",
            "geography": "地理"
        }
        for card in data.activeCards:
            if not card.name or not card.name.strip():
                continue
            card_type_zh = type_map.get(card.type, card.type)
            summary_part = f"：{card.summary.strip()}" if card.summary and card.summary.strip() else ""
            card_str = f"- 【{card_type_zh}】{card.name}{summary_part}"
            if card.details and card.details.strip():
                details_indented = "\n  ".join(line for line in card.details.strip().splitlines())
                card_str += f"\n  详细设定：{details_indented}"
            
            if card.activeState == "sceneActive":
                scene_active_list.append(card_str)
            elif card.activeState == "globalActive":
                global_active_list.append(card_str)

    if scene_active_list or global_active_list:
        active_cards_block = "【活跃设定上下文】\n"
        if scene_active_list:
            active_cards_block += "当前场景活跃设定：\n" + "\n".join(scene_active_list) + "\n"
        if global_active_list:
            active_cards_block += "全局活跃设定：\n" + "\n".join(global_active_list) + "\n"
        active_cards_block += "\n"

    return (
        f"【角色设定与世界观积木】\n世界观：{d.worldviewBlock}\n主角：{d.protagonistBlock}\n"
        f"对手：{d.antagonistBlock}\n叙事色调：{d.narrativeTone}\n\n"
        f"{active_cards_block}"
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


def build_scene_system_prompt(data: SceneTextInput) -> str:
    """成稿正文 system prompt（纯函数，可单测）。端点与评测共用,零漂移。
    反套路硬约束 + 可选红队对抗规则 + 文风寄存器子句。"""
    adv = ANTI_SLOP_CONSTRAINT
    if data.adversarialRules and data.adversarialRules.strip():
        adv += f"\n【用户红队对抗规则（必须遵守）】：{data.adversarialRules.strip()}"
    return (
        "你是一位文字极具颗粒度的小说家。请根据给定的设定积木与当前分镜大纲创作小说正文。\n"
        + adv
        + build_tone_clause(data.tone)
        + "\n直接输出正文，不要任何前言、标题或解释。"
    )


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


def build_book_direct_prompts(data: BookDirectInput) -> tuple[str, str]:
    """整本直提 (system, user)。content 的空检查留在 handler;此处复刻截断逻辑。"""
    content = sanitize_text(data.content)
    if len(content) > MAX_DIRECT_INPUT_CHARS:
        content = content[:MAX_DIRECT_INPUT_CHARS]
    system = (
        "你是一个顶级的小说架构大师与叙事学者。下面给出一本小说接近完整的正文（可能为节选/截断）。"
        "请整体把握全书后，" + FOUR_LAYER_DNA_GUIDE
    )
    user = f"小说名：{data.novelName or '（未命名）'}\n\n【小说正文】\n{content}"
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
        "你是一个顶级的小说架构大师与叙事学者。下面是这本小说全部章节/弧窗提炼出的 Map 摘要序列（按时间线排列）。"
        "请通过长上下文综合推理，" + FOUR_LAYER_DNA_GUIDE
    )
    user = f"小说名：{data.novelName or '（未命名）'}\n\n章节/弧窗 Map 摘要序列：\n{timeline}"
    return system, user


def build_arc_map_prompts(data: ArcMapInput) -> tuple[str, str]:
    """弧窗 map (system, user)。content/title 的空检查留在 handler;此处复刻截断逻辑。"""
    title = sanitize_text(data.title)
    content = sanitize_text(data.content)
    if len(content) > MAX_ARC_CONTENT_CHARS:
        content = content[:MAX_ARC_CONTENT_CHARS]
    system = (
        "你是一个极其挑剔的文学分析编辑。下面是一段【连续章节区间】的正文（可能跨多章）。"
        "请对这段区间整体降维提炼，过滤对话、抒情、招式细节等冗余，只关注实质性的'DNA 突变点'：\n"
        "1. 本区间新展现的底层设定、地图或规则？\n"
        "2. 主角的情感底线 / 核心动机 / 人际关系发生的不可逆变化？\n"
        "3. 本区间最核心的情节推力（含关键转折与爽点）？\n"
        "4. 本区间独特的遣词造句或叙事语调特征？\n"
        "用极度精炼、非情绪化的骨架语言回答，每项控制在 150 字内；某项无内容则填'无'。"
    )
    user = f"区间标识: {title}\n\n区间正文:\n{content}"
    return system, user


def _fusion_parts(data: FusionDirectionsInput) -> tuple[str, str, str]:
    """复刻源 handler 的 beats / skin_block / extra 拼装(换皮方向用)。"""
    engine = data.engineCard
    beats = "\n".join(
        f"- {b.function}：{b.summary}" for b in engine.structureSkeleton if (b.function or "").strip()
    ) or "（结构骨架为空）"
    skin = data.skinSource
    if skin and (skin.novelName or (skin.themeSkin or "").strip()):
        skin_block = (
            f"题材来源：{skin.novelName or '（口述）'}\n"
            f"题材世界观与意象：{skin.themeSkin or '（未提供，可据来源自行归纳）'}\n"
            f"参考文笔质感：{skin.proseStyle or '（无特别要求）'}"
        )
        if skin.userBrief and skin.userBrief.strip():
            skin_block += f"\n用户额外诉求：{skin.userBrief.strip()}"
    else:
        brief = (skin.userBrief.strip() if (skin and skin.userBrief) else "")
        skin_block = (
            "（自我裂变：无题材书，请基于用户口述/自由发挥另立一个与原书反差鲜明的新题材）\n"
            f"用户口述题材诉求：{brief or '（未指定，请自选一个反差鲜明的新题材）'}"
        )
    extra = ""
    if data.userCustomPrompt and data.userCustomPrompt.strip():
        extra += f"\n\n【用户自定义大方向】：{data.userCustomPrompt.strip()}"
    if data.adversarialRules and data.adversarialRules.strip():
        extra += f"\n\n【用户红队对抗规则（最高优先级，违反即重写）】：{data.adversarialRules.strip()}"
    if data.avoidDirections:
        avoid_lines = "\n".join(
            f"- {a.strip()}" for a in data.avoidDirections if (a or "").strip()
        )
        if avoid_lines:
            extra += (
                "\n\n【已生成过的方向（必须明显避开：题材内核 / 核心机制 / 角色配置都要换，"
                "禁止换名雷同或换汤不换药）】：\n" + avoid_lines
            )
    return beats, skin_block, extra


def build_fusion_directions_prompts(data: FusionDirectionsInput) -> tuple[str, str]:
    """融合方向 (system, user)。freedom True/False 双分支,文本逐字对照源 handler。
    注:engineCard 必填校验留在 handler(返回 400)。"""
    engine = data.engineCard
    beats, skin_block, extra = _fusion_parts(data)
    if data.freedom:
        system = (
            "你是一位富于原创力的小说立项策划（学理：把 Propp 功能 / 类推迁移当作【灵感源】，而非模具）。"
            "任务：把【骨架引擎】的功能节拍仅当灵感调色板，产出 3 个真正原创、彼此迥异的开篇立项方向。\n"
            "原则：\n"
            "1. DNA 是灵感不是模具——可自由重组 / 增删 / 跳过 / 另起结构节拍，不必保留原书的节拍序列与顺序。\n"
            "2. 用户意图（想往哪写 / 口述题材 / 反套路约束）权重高于源书节拍；二者冲突时优先服从用户意图，大胆偏离源书。\n"
            "3. 3 个方向须采用迥异的核心创意（题材内核 / 主题 / 机制 / 主角配置都不同），禁止换名式雷同，也禁止三个都只是源书的近似重映射。\n"
            "4. 每个方向给出：title、concept（一句话核心冲突）、catalyst（催化变量及其质变）、"
            "worldviewBlock / protagonistBlock / antagonistBlock / narrativeTone（具体设定四块）、"
            "transferNote（一句话：从引擎借用了什么灵感、又如何大胆偏离 / 重组）。\n"
            "5. 设定四块要逻辑自洽、可支撑后续开篇正文；文风随题材自由生长、鼓励鲜明个性，不必压成统一冷腔。\n"
            "（文风提示：仍尽量避免「命运的齿轮」「那一刻」之类陈词滥调与空洞煽情，但不强制统一冷腔——优先贴合各自题材的鲜明文风。）"
        )
        user = (
            f"【可借用的引擎灵感（仅供参考，可自由取舍 / 重组 / 另起，非约束）】\n来源：{engine.novelName or '（未命名）'}\n"
            f"结构功能节拍：\n{beats}\n编排节奏参考：{engine.pacingSyuzhet or '（未提供）'}\n\n"
            f"【创作主轴（最高权重）与题材调色板】\n{skin_block}{extra}\n\n"
            "请以用户意图为主轴、引擎仅作灵感，产出 3 个真正原创、彼此迥异的开篇立项方向。"
        )
    else:
        system = (
            "你是一位精通「换皮变题」的小说迁移大师（学理：Propp 功能不变·角色可替换；Riedl『story analogues』类推迁移）。"
            "任务：把【骨架引擎】的功能节拍序列，逐一类推迁移到【新题材皮】，产出 3 个『形似神不似』的换皮嫁接方向。\n"
            "硬规则：\n"
            "1. 保持引擎的功能节拍序列与编排节奏不变——同一套结构骨架与爽点曲线，只换皮、不换骨。\n"
            "2. 把每个功能节拍重新具象化为新题材里的等价事件（角色 / 道具 / 场景 / 机制换皮，功能不变），严禁照抄原书的题材名词。\n"
            "3. 3 个方向必须采用显著不同的嫁接思路（如：题材直译 / 反转母题 / 杂交第三元素），彼此在题材与机制上明显区分，禁止换名式雷同。\n"
            "4. 每个方向给出：title、concept（一句话核心冲突）、catalyst（催化变量及其质变）、"
            "worldviewBlock / protagonistBlock / antagonistBlock / narrativeTone（换皮后的新书具体设定四块）、"
            "transferNote（一句话溯源：保留了引擎的哪条结构、替换成了什么题材皮）。\n"
            "5. 设定四块要逻辑自洽、可支撑后续开篇正文；narrativeTone 贴合新题材重新生成文笔，不照搬原书。\n"
            + ANTI_SLOP_CONSTRAINT
        )
        user = (
            f"【骨架引擎（迁移不变量）】\n来源：{engine.novelName or '（未命名）'}\n"
            f"结构功能节拍序列：\n{beats}\n编排节奏：{engine.pacingSyuzhet or '（未提供）'}\n\n"
            f"【新题材皮（替换目标）】\n{skin_block}{extra}\n\n"
            "请输出 3 个换皮嫁接方向。"
        )
    return system, user


def resolve_fusion_temperature(data: FusionDirectionsInput) -> float:
    """freedom 抬高 variation:temperature 下限 0.9(对照源 handler)。"""
    if data.freedom:
        return min(1.5, max(data.temperature, 0.9))
    return data.temperature


FORBIDDEN_STYLE_WORDS = [
    "不可否认", "嘴角上扬", "总而言之", "总之", "翻译腔", "命运的齿轮",
    "那一刻", "逆天改命", "眼神变得坚定", "嘴角勾起一抹弧度",
    "仿佛整个世界都安静了", "空气仿佛凝固", "心中一紧", "缓缓睁开眼", "不知为何"
]


def build_evaluator_system_prompt(data: SceneEvaluateInput) -> str:
    """后端 Evaluator Agent 质检三把锁系统提示词"""
    return (
        "你是一位极其严苛的小说草稿质检审计员（Evaluator Agent）。你的任务是针对生成的草稿进行深度逻辑审计与质量评估，执行“质检三把锁”校验，并输出结构化 JSON 评估报告。\n\n"
        "【质检三把锁审计标准】\n"
        "1. 风格锁（Style Lock）：\n"
        "   - 审查 AI 腔调（如“不可否认”、“嘴角上扬”、“总之”、“总而言之”、“命运的齿轮”、“那一刻”、“眼神变得坚定”、“嘴角勾起一抹弧度”、“仿佛整个世界都安静了”等违禁词和陈词滥调）、翻译腔与废话。\n"
        "   - 检验文本是否符合给定的文风色调与叙事基调（narrativeTone）。\n"
        "2. 人设锁（Consistency Lock）：\n"
        "   - 核对文本有无违背活跃/全局角色设定及世界常识（比对活跃设定卡片 activeCards 和创作方向设定 selectedDirection 中的主角/对手设定）。\n"
        "   - 拦截逻辑违和与设定硬伤（例如：瞎子看四周/看表、聋子听琴、死人说话、没有修为的人飞天等）。\n"
        "3. 大纲锁（Outline Lock）：\n"
        "   - 检查文本是否包含且体现了当前场景大纲（currentScene.plotOutline）规定的剧情核心冲突、转折点与爽点/爆点。\n\n"
        "【输出约束说明】\n"
        "- 如果任意一把锁未通过（passed = False），必须在对应的 reason 中指明具体原因与原文违规证据，并在最终的 actionableFeedback 中给出具体、可执行、无废话的重写改进指令。\n"
        "- 如果该锁通过（passed = True），则 reason 填空字符串 \"\"；如果三把锁全部通过，则 actionableFeedback 也必须为 \"\"。\n"
        "- 必须以严格的结构化 JSON 格式输出，符合定义的 SceneAuditResult 模式。"
    )


def build_evaluator_user_prompt(data: SceneEvaluateInput) -> str:
    """后端 Evaluator Agent 质检三把锁用户提示词，组装待评估的上下文与草稿文本"""
    d = data.selectedDirection
    scene = data.currentScene

    # 组装活跃设定卡片信息
    active_cards_block = "（无活跃设定卡片）"
    if data.activeCards:
        card_lines = []
        type_map = {
            "worldview": "世界规章",
            "character": "人物",
            "prop": "道具",
            "geography": "地理"
        }
        for card in data.activeCards:
            if not card.name or not card.name.strip():
                continue
            card_type_zh = type_map.get(card.type, card.type)
            summary_part = f"：{card.summary.strip()}" if card.summary and card.summary.strip() else ""
            card_str = f"- 【{card_type_zh}】{card.name}{summary_part}"
            if card.details and card.details.strip():
                details_indented = "\n  ".join(line for line in card.details.strip().splitlines())
                card_str += f"\n  详细设定：{details_indented}"
            card_lines.append(card_str)
        if card_lines:
            active_cards_block = "\n".join(card_lines)

    return (
        f"【评估输入上下文】\n"
        f"1. 场景 ID (sceneId): {data.sceneId}\n"
        f"2. 尝试轮次 (attempt): {data.attempt}\n\n"
        f"【融合方向设定 (selectedDirection)】\n"
        f"- 世界观: {d.worldviewBlock}\n"
        f"- 主角设定: {d.protagonistBlock}\n"
        f"- 对手设定: {d.antagonistBlock}\n"
        f"- 叙事风格/色调 (narrativeTone): {d.narrativeTone}\n\n"
        f"【当前场景大纲 (currentScene)】\n"
        f"- 标题: {scene.sceneTitle}\n"
        f"- 情节走向与核心冲突 (plotOutline): {scene.plotOutline}\n"
        f"- 张力曲线: {scene.tensionLevel}\n"
        f"- 画面意象: {scene.visualCues}\n\n"
        f"【活跃设定卡片 (activeCards)】\n"
        f"{active_cards_block}\n\n"
        f"==================================================\n"
        f"【待审计的小说草稿正文 (draft)】\n"
        f"{data.draft}\n"
        f"==================================================\n\n"
        f"请针对上述待审计的小说草稿正文执行”质检三把锁”审计，并输出结构化评估结果。"
    )


# ============================================================
# Story 3.4: 对话智能意图解析 — Chat Assistant Prompt
# ============================================================

def _format_entity_cards_context(entity_cards: list[EntityCardUpdate]) -> str:
    """将已有设定卡片格式化为上下文段落，供 AI 精确识别已有实体。"""
    if not entity_cards:
        return "（暂无设定卡片）"
    type_map = {"worldview": "世界规章", "character": "人物", "prop": "道具", "geography": "地理"}
    lines = []
    for card in entity_cards:
        card_type_zh = type_map.get(card.type, card.type)
        summary_part = f"——{card.summary}" if card.summary else ""
        lines.append(f"- [{card_type_zh}] id={card.card_id} name={card.name}{summary_part}")
    return "\n".join(lines)


def _format_outline_context(
    volumes: list[VolumeItem],
    chapters: list[ChapterItem],
    scenes: list[SceneItem],
) -> str:
    """将已有大纲格式化为树形上下文。"""
    if not volumes and not chapters and not scenes:
        return "（暂无大纲）"
    lines = []
    for vol in sorted(volumes, key=lambda v: v.order):
        lines.append(f"卷 id={vol.id} title={vol.title}")
        vol_chapters = sorted(
            [ch for ch in chapters if ch.volume_id == vol.id],
            key=lambda c: c.order,
        )
        for ch in vol_chapters:
            lines.append(f"  章 id={ch.id} title={ch.title}")
            ch_scenes = sorted(
                [s for s in scenes if s.chapter_id == ch.id],
                key=lambda s: s.order,
            )
            for sc in ch_scenes:
                lines.append(f"    幕 id={sc.id} title={sc.title}")
    # 无卷的章
    orphan_chapters = [ch for ch in chapters if not any(v.id == ch.volume_id for v in volumes)]
    for ch in sorted(orphan_chapters, key=lambda c: c.order):
        lines.append(f"  章（无卷）id={ch.id} title={ch.title}")
    return "\n".join(lines) if lines else "（暂无大纲）"


def build_chat_assistant_system_prompt(
    entity_cards: list[EntityCardUpdate],
    volumes: list[VolumeItem],
    chapters: list[ChapterItem],
    scenes: list[SceneItem],
) -> str:
    """对话助手系统提示词：指示 AI 解析用户意图并输出结构化更新。"""
    cards_ctx = _format_entity_cards_context(entity_cards)
    outline_ctx = _format_outline_context(volumes, chapters, scenes)

    return (
        "你是创作工坊的 AI 助手。用户会在对话中指挥你修改设定卡片或大纲（卷/章/幕）。\n"
        "你的任务：\n"
        "1. 理解用户自然语言意图（如”把林鸣的性格改为冷酷”、”新建一个叫流光剑的道具卡”、”删除第二卷”）。\n"
        "2. 在 reply 字段用简洁中文回应用户。\n"
        "3. 在对应的 updates 字段中输出精确的结构化操作。\n\n"
        "【关键规则】\n"
        "- 修改已有卡片时，必须使用其已有的 cardId，严禁分配新 ID 导致冗余。\n"
        "- 修改已有大纲节点时，必须使用其已有的 id。\n"
        "- 新建实体时 cardId/id 留空字符串，由前端生成。\n"
        "- 删除操作需填写 action=\"delete\" 并提供对应 id。\n"
        "- 如果用户指令与设定/大纲修改无关（如闲聊、问答），仅在 reply 回答即可，updates 留空数组。\n"
        "- upsert 操作时，name 字段必须填写。\n\n"
        f"【当前已有设定卡片】\n{cards_ctx}\n\n"
        f"【当前已有大纲结构】\n{outline_ctx}\n\n"
        "请严格按照 ChatAssistantResponse 结构输出。"
    )


def build_chat_assistant_user_prompt(messages: list[ChatMessage]) -> str:
    """多轮对话 → 转写：历史轮供上下文/指代，末条 user 为当前指令。

    此前端点只取最后一条 user 消息、丢弃全部历史，导致多轮指代失效（review #2）。
    """
    convo = [m for m in messages if m.role in ("user", "assistant")]
    # 末条 user 作为当前指令；其之前的所有轮作为历史。
    last_user_idx = -1
    for i in range(len(convo) - 1, -1, -1):
        if convo[i].role == "user":
            last_user_idx = i
            break
    if last_user_idx == -1:
        return ""
    current = convo[last_user_idx].content
    history = convo[:last_user_idx]
    role_label = {"user": "用户", "assistant": "助手"}
    parts: list[str] = []
    if history:
        hist_block = "\n".join(f"{role_label.get(m.role, m.role)}：{m.content}" for m in history)
        parts.append(
            "【对话历史（供理解上下文与指代，请勿重复执行历史里已完成的指令）】\n"
            + hist_block
            + "\n"
        )
    parts.append("【当前用户指令】\n" + current)
    return "\n".join(parts)

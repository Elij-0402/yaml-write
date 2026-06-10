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

import asyncio
import ipaddress
import json
import logging
import os
import random
import re
import time
from collections import defaultdict, deque
from typing import Deque
from urllib.parse import urlsplit, urlunsplit

import instructor
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
)
from api.schemas import (
    BookReduceInput,
    ChapterMapInput,
    ChapterMapSummaryResponse,
    FusionDirectionsInput,
    FusionDirectionsResponse,
    NovelDNACardResponse,
    SceneTextInput,
    SplitRecommendInput,
    SplitRecommendResponse,
    StoryboardInput,
    StoryboardResponse,
    TweakBlocksInput,
    TweakBlocksResponse,
)

logger = logging.getLogger("novel_fusion_api")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)

app = FastAPI(docs_url="/api/py/docs", openapi_url="/api/py/openapi.json")

REQUEST_TIMEOUT_SECONDS = 25.0
STREAM_TIMEOUT_SECONDS = 60.0
MAX_PARSE_RETRIES = 2
MAX_CHAPTER_CONTENT_CHARS = 30000
MAX_REDUCE_INPUT_CHARS = 200000
MAX_SCENE_CONTEXT_CHARS = 24000
MAX_SPLIT_RECOMMEND_CHARS = 20000
RATE_LIMIT_RULES = {
    "/api/py/extract-chapter-map": (60, 120),
    "/api/py/extract-book-reduce": (60, 10),
    "/api/py/generate-fusion-directions": (60, 8),
    "/api/py/tweak-fusion-blocks": (60, 20),
    "/api/py/generate-storyboard": (60, 12),
    "/api/py/stream-storyboard": (60, 12),
    "/api/py/stream-scene-text": (60, 12),
    "/api/py/split-recommend": (60, 20),
}

# 反 AI 套路硬约束（各创作 prompt 复用）
ANTI_SLOP_CONSTRAINT = (
    "【反 AI 套路硬约束】严禁出现陈词滥调与空洞煽情，包括但不限于："
    "“命运的齿轮”“那一刻”“逆天改命”“眼神变得坚定”“嘴角勾起一抹弧度”“仿佛整个世界都安静了”"
    "“空气仿佛凝固”“心中一紧”“缓缓睁开眼”“不知为何”等。"
    "禁止宏大空泛的抒情与解释性旁白；改用冰冷、具象、高信息密度的物理细节与克制白描，"
    "让冲突通过动作、环境与器物呈现，而非作者直接告知。文字要有颗粒度与刺痛感。"
)

DEFAULT_ALLOWED_BASE_URLS = [
    "https://api.openai.com/v1",
    "https://api.deepseek.com/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://api.siliconflow.cn/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1",
    "http://[::1]:11434/v1",
]
ALLOWED_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
LOCAL_PORTS = {11434}

_rate_limit_buckets: dict[str, Deque[float]] = defaultdict(deque)
_rate_limit_lock = asyncio.Lock()


class ApiError(Exception):
    def __init__(self, *, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def error_payload(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


# === API Key 脱敏防线（AC2）：杜绝任何明文密钥流入 stdout/stderr 日志 ===
_SENSITIVE_KEY_RE = re.compile(r'(?i)("?api_?key"?\s*[:=]\s*")([^"]+)(")')


def mask_api_key(api_key: str) -> str:
    """将 API Key 掩码为 sk-***[后四位]，仅保留可辨识的前缀与末四位。"""
    key = (api_key or "").strip()
    if len(key) <= 7:
        return "***"
    return f"{key[:3]}***{key[-4:]}"


def scrub_sensitive(text: str) -> str:
    """正则 (?i)api_?key 捕获敏感字段并掩码其值，用于任何对外文本/日志。"""
    return _SENSITIVE_KEY_RE.sub(lambda m: f"{m.group(1)}{mask_api_key(m.group(2))}{m.group(3)}", text)


def resolve_allowed_base_urls() -> list[str]:
    raw = os.getenv("ALLOWED_LLM_BASE_URLS", "")
    extra = [item.strip() for item in raw.split(",") if item.strip()]
    urls = [*DEFAULT_ALLOWED_BASE_URLS, *extra]

    normalized: list[str] = []
    for url in urls:
        try:
            normalized.append(normalize_base_url(url))
        except ApiError:
            logger.warning("skip invalid allowlist base url: %s", url)
    return normalized


def normalize_base_url(base_url: str) -> str:
    parsed = urlsplit(base_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ApiError(status_code=400, code="invalid_base_url", message="Base URL 格式无效。")

    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ApiError(status_code=400, code="invalid_base_url", message="Base URL 不能包含认证信息、查询参数或片段。")

    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    port = parsed.port
    path = (parsed.path or "").rstrip("/")
    if not path:
        path = "/v1"

    if scheme == "http" and host not in ALLOWED_LOCAL_HOSTS:
        raise ApiError(status_code=400, code="insecure_base_url", message="仅本地地址允许使用 HTTP。")

    return urlunsplit((scheme, f"{host}:{port}" if port else host, path, "", ""))


def validate_base_url(base_url: str) -> str:
    normalized = normalize_base_url(base_url)
    parsed = urlsplit(normalized)
    host = parsed.hostname or ""

    try:
        ip_obj = ipaddress.ip_address(host)
        is_local = ip_obj.is_loopback
        is_blocked = ip_obj.is_private or ip_obj.is_link_local or ip_obj.is_reserved or ip_obj.is_multicast or ip_obj.is_unspecified
        if is_blocked and not is_local:
            raise ApiError(status_code=400, code="blocked_private_network", message="Base URL 指向了受限的内网地址。")
        if is_local and parsed.port not in LOCAL_PORTS:
            raise ApiError(status_code=400, code="blocked_local_port", message="本地地址仅允许白名单端口。")
    except ValueError:
        if host == "localhost" and parsed.port not in LOCAL_PORTS:
            raise ApiError(status_code=400, code="blocked_local_port", message="本地地址仅允许白名单端口。")

    allowed = set(resolve_allowed_base_urls())
    if normalized not in allowed:
        raise ApiError(status_code=400, code="base_url_not_allowed", message="Base URL 不在允许列表中。")
    return normalized


def validate_llm_creds(api_key: str, model: str, temperature: float) -> None:
    if not api_key.strip():
        raise ApiError(status_code=400, code="invalid_request", message="API Key 不能为空。")
    if not model.strip():
        raise ApiError(status_code=400, code="invalid_request", message="模型名称不能为空。")
    if not (0 <= temperature <= 1.5):
        raise ApiError(status_code=400, code="invalid_temperature", message="temperature 必须在 0 到 1.5 之间。")


def classify_openai_error(exc: Exception) -> tuple[int, str, str]:
    if isinstance(exc, AuthenticationError):
        return 401, "auth_error", "API Key 无效或已失效。"
    if isinstance(exc, PermissionDeniedError):
        return 403, "permission_denied", "当前 API Key 无权限访问该模型。"
    if isinstance(exc, NotFoundError):
        return 404, "model_or_endpoint_not_found", "模型不存在，或 Base URL 与模型不匹配。"
    if isinstance(exc, RateLimitError):
        return 429, "rate_limited", "请求过于频繁或额度不足，请稍后重试。"
    if isinstance(exc, APITimeoutError):
        return 504, "upstream_timeout", "上游模型响应超时，请稍后重试。"
    if isinstance(exc, APIConnectionError):
        return 502, "upstream_connection_error", "无法连接上游模型服务，请检查网络或 Base URL。"
    if isinstance(exc, BadRequestError):
        msg = "请求参数无效。"
        raw = str(exc).lower()
        if "tool" in raw or "response_model" in raw or "structured" in raw:
            msg = "该模型不支持结构化解析，请切换到支持结构化输出的 Chat 模型。"
        return 400, "bad_request", msg
    if isinstance(exc, APIStatusError):
        status = exc.status_code or 502
        if status >= 500:
            return 502, "upstream_server_error", "上游模型服务异常，请稍后重试。"
        if status == 429:
            return 429, "rate_limited", "请求过于频繁或额度不足，请稍后重试。"
        return status, "upstream_error", "上游模型返回错误，请检查配置并重试。"
    return 500, "internal_error", "服务暂时不可用，请稍后重试。"


def raise_friendly_api_error(exc: Exception) -> None:
    status_code, code, message = classify_openai_error(exc)
    raise ApiError(status_code=status_code, code=code, message=message) from exc


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def ensure_rate_limit(request: Request, endpoint: str) -> None:
    window_seconds, max_requests = RATE_LIMIT_RULES.get(endpoint, (60, 30))
    now = time.time()
    client_key = f"{get_client_ip(request)}:{endpoint}"

    async with _rate_limit_lock:
        queue = _rate_limit_buckets[client_key]
        cutoff = now - window_seconds
        while queue and queue[0] < cutoff:
            queue.popleft()
        if len(queue) >= max_requests:
            raise ApiError(status_code=429, code="rate_limited", message="请求频率过高，请稍后再试。")
        queue.append(now)


def sse_event(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


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


_STORYBOARD_SCENE_PATTERN = re.compile(
    r"\[SCENE-(\d+)\]\s*"
    r"title:\s*(.*?)\s*"
    r"plot:\s*(.*?)\s*"
    r"tension:\s*(.*?)\s*"
    r"visual:\s*(.*?)\s*"
    r"\[/SCENE-\1\]",
    re.IGNORECASE | re.DOTALL,
)


def parse_storyboard_scene_blocks(raw_text: str, scene_count: int) -> list[dict]:
    scenes: list[dict] = []
    for match in _STORYBOARD_SCENE_PATTERN.finditer(raw_text):
        scenes.append(
            {
                "sceneNumber": int(match.group(1)),
                "sceneTitle": match.group(2).strip(),
                "plotOutline": match.group(3).strip(),
                "tensionLevel": match.group(4).strip(),
                "visualCues": match.group(5).strip(),
            }
        )

    scenes.sort(key=lambda x: x["sceneNumber"])
    if len(scenes) != scene_count:
        return []
    if any(not s["sceneTitle"] or not s["plotOutline"] for s in scenes):
        return []
    return scenes


def build_openai_client(api_key: str, base_url: str, timeout: float) -> AsyncOpenAI:
    normalized_base_url = validate_base_url(base_url)
    return AsyncOpenAI(
        api_key=api_key.strip(),
        base_url=normalized_base_url,
        timeout=timeout,
        max_retries=0,
    )


async def run_structured(
    *,
    api_key: str,
    base_url: str,
    model: str,
    response_model,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    request: Request,
    label: str,
    instructor_retries: int = 0,
):
    """Shared structured-extraction call: instructor + transient retry + friendly errors."""
    client = instructor.from_openai(
        build_openai_client(api_key, base_url, timeout=REQUEST_TIMEOUT_SECONDS)
    )
    for attempt in range(MAX_PARSE_RETRIES + 1):
        try:
            return await client.chat.completions.create(
                model=model,
                response_model=response_model,
                temperature=temperature,
                max_retries=instructor_retries,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
        except Exception as exc:
            status_code, code, message = classify_openai_error(exc)
            should_retry = status_code in {429, 502, 503, 504} and attempt < MAX_PARSE_RETRIES
            if should_retry:
                await asyncio.sleep((2 ** attempt) + random.uniform(0.1, 0.4))
                continue
            logger.warning("%s failed ip=%s model=%s err=%s", label, get_client_ip(request), model, exc.__class__.__name__)
            raise ApiError(status_code=status_code, code=code, message=message) from exc


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return JSONResponse(status_code=exc.status_code, content=error_payload(exc.code, exc.message))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content=error_payload("invalid_request", scrub_sensitive(f"参数校验失败：{exc.errors()[0].get('msg', '请求参数不合法。')}")),
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    logger.exception("unhandled error endpoint=%s ip=%s", request.url.path, get_client_ip(request))
    return JSONResponse(status_code=500, content=error_payload("internal_error", "服务暂时不可用，请稍后重试。"))


@app.post("/api/py/extract-chapter-map")
async def extract_chapter_map(data: ChapterMapInput, request: Request):
    await ensure_rate_limit(request, "/api/py/extract-chapter-map")
    title = sanitize_text(data.title)
    content = sanitize_text(data.content)
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    if not title or not content:
        raise ApiError(status_code=400, code="invalid_request", message="章节标题与内容不能为空。")
    if len(content) > MAX_CHAPTER_CONTENT_CHARS:
        raise ApiError(
            status_code=413,
            code="content_too_large",
            message=f"章节内容超长（上限 {MAX_CHAPTER_CONTENT_CHARS} 字符），请先切分。",
        )
    validate_llm_creds(api_key, model, data.temperature)
    logger.info("extract_chapter_map ip=%s model=%s content_chars=%s", get_client_ip(request), model, len(content))

    system_prompt = (
        "你是一个极其挑剔的文学分析编辑。请对给定章节标题与内容进行降维提炼，"
        "过滤掉一切对话、抒情、战斗招式细节等冗余文本，只关注实质性的'DNA 突变点'：\n"
        "1. 出现了哪些前所未有的设定、地图或规则？\n"
        "2. 主角的情感底线、核心动机或人际关系发生了什么不可逆变化？\n"
        "3. 本章最核心的情节推力是什么？\n"
        "4. 本章独特的遣词造句或叙事语调特征？\n"
        "请用极度精炼、非情绪化的骨架语言回答，每一项控制在 100 字内；某项无内容则填'无'。"
    )
    user_prompt = f"章节标题: {title}\n\n章节内容:\n{content}"
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=ChapterMapSummaryResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="extract_chapter_map",
    )


@app.post("/api/py/extract-book-reduce")
async def extract_book_reduce(data: BookReduceInput, request: Request):
    await ensure_rate_limit(request, "/api/py/extract-book-reduce")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)

    lines = []
    for idx, m in enumerate(data.mapSummaries):
        lines.append(
            f"第 {idx + 1} 章 | 设定:{m.worldviewUpdates} | 情节:{m.keyPlotTurns} | "
            f"角色:{m.characterDevelopments} | 风格:{m.styleObservations}"
        )
    timeline = "\n".join(lines)
    if len(timeline) > MAX_REDUCE_INPUT_CHARS:
        timeline = timeline[:MAX_REDUCE_INPUT_CHARS]
    logger.info("extract_book_reduce ip=%s model=%s chapters=%s", get_client_ip(request), model, len(data.mapSummaries))

    system_prompt = (
        "你是一个顶级的小说架构大师。下面是这本小说所有章节提炼出的 Map 摘要序列（按时间线排列）。"
        "请通过长上下文推理，提炼出这本小说最深层的'创作 DNA 结构'：\n"
        "1. 母题与冲突：作者潜意识反复探讨的底层命题（如：秩序与失控的拉扯、技术与人性的自我拆解）。\n"
        "2. 世界观运行规则与代价：世界如何流转？获取力量或地位的底层代价是什么？\n"
        "3. 角色灵魂原型：主角与主要角色的深层冲突、认知缺陷与救赎轨迹。\n"
        "4. 叙事结构特征与视角排布规律。\n"
        "5. 风格指纹：全书语言特色的高频意象与笔触质感。\n"
        "请以精炼、充满洞察力的结构返回。"
    )
    user_prompt = f"小说名：{data.novelName or '（未命名）'}\n\n章节 Map 摘要序列：\n{timeline}"
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=NovelDNACardResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="extract_book_reduce",
    )


@app.post("/api/py/generate-fusion-directions")
async def generate_fusion_directions(data: FusionDirectionsInput, request: Request):
    await ensure_rate_limit(request, "/api/py/generate-fusion-directions")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)
    logger.info("generate_fusion_directions ip=%s model=%s books=%s", get_client_ip(request), model, len(data.dnaCards))

    cards = []
    for idx, c in enumerate(data.dnaCards):
        cards.append(
            f"=== 小说 {idx + 1}：{c.novelName or '（未命名）'} ===\n"
            f"母题与冲突：{c.theme}\n世界观规则与代价：{c.worldview}\n"
            f"角色灵魂原型：{c.characters}\n叙事特征：{c.narrativeStyle}\n风格指纹：{c.styleFingerprint}"
        )
    dna_block = "\n\n".join(cards)
    extra = ""
    if data.userCustomPrompt and data.userCustomPrompt.strip():
        extra += f"\n\n【用户自定义大方向】：{data.userCustomPrompt.strip()}"
    if data.adversarialRules and data.adversarialRules.strip():
        extra += f"\n\n【用户红队对抗规则（最高优先级，违反即重写）】：{data.adversarialRules.strip()}"

    system_prompt = (
        "你是一个由三位顶尖创作大脑组成的'创世圆桌'，并内置一名冷面红队审查官。"
        "你的任务：基于输入的多本小说'创作 DNA'，碰撞出 3 个完全独立、互不雷同、具备高维原创性的融合变体方向。\n"
        "请在内部（不外显推演过程）完成以下步骤后，只输出最终 3 个方向：\n"
        "第一步·摩擦力诊断：计算这些 DNA 之间最尖锐的偏离与矛盾点（例：'追求自然天道'撞上'极致资本科技'→ "
        "天道修行能否被资本化、义体化），以核心摩擦点作为变体的引爆原点，而非表面元素拼贴。\n"
        "第二步·三编剧圆桌辩论：\n"
        "· 先锋导演（催化剂）：打破常规，提出最极致的世界观反转与最具冲击力的'催化变量'。坚决反对'把飞剑染成霓虹色'式肤浅拼凑，"
        "主张本质级重构（如'灵气本是重度致幻的工业废料，跨国集团垄断净化核心，散修须将身体改造成气脉过滤器才能活命'）。\n"
        "· 现实主义社会学者（法则构建师）：为激进幻想搭建严密的社会经济与代价体系（如'修行层级晋升＝持股量增多，天劫＝集团强制清算重组'），确保逻辑自洽。\n"
        "· 反套路批评家（红队）：清扫一切宏大空泛叙事与煽情辞藻，强制冷白描与高信息密度物理细节。\n"
        "第三步·红队自查：逐条核对每个方向——是否只是名字替换式的机械缝合？是否违反用户红队规则？是否含黑名单陈词滥调？不合格者就地重写直至通过。\n"
        "3 个方向之间必须在母题与机制上显著不同，禁止换皮。\n"
    )
    if len(data.dnaCards) == 2:
        system_prompt += (
            f"\n\n【融合偏航倾向】：参与融合的两部作品中，"
            f"小说 1 的比重权重为 {data.fusionBias:.2f}，小说 2 的比重权重为 {1.0 - data.fusionBias:.2f}。"
            f"请在小说融合理念设计、世界观、主角和叙事风格的变体生成中，严格遵循此权重比例主导倾向，进行深层的语义插值合成。"
        )
    system_prompt += ANTI_SLOP_CONSTRAINT
    user_prompt = f"以下是参与碰撞的小说创作 DNA：\n\n{dna_block}{extra}\n\n请输出 3 个深度融合的原创变体方向。"
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=FusionDirectionsResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="generate_fusion_directions",
        instructor_retries=2,
    )


@app.post("/api/py/tweak-fusion-blocks")
async def tweak_fusion_blocks(data: TweakBlocksInput, request: Request):
    await ensure_rate_limit(request, "/api/py/tweak-fusion-blocks")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    instruction = sanitize_text(data.userInstruction)
    if not instruction:
        raise ApiError(status_code=400, code="invalid_request", message="修改指令不能为空。")
    validate_llm_creds(api_key, model, data.temperature)
    logger.info("tweak_fusion_blocks ip=%s model=%s", get_client_ip(request), model)

    target_guard = ""
    if data.targetBlock:
        target_guard = (
            f"\n【本次目标卡片】{data.targetBlock}。"
            f"本次仅允许修改该卡片；modifiedBlocks 只能包含 {data.targetBlock}。"
            "其他卡片必须返回 null 且不得改写。"
        )

    adv = ""
    if data.adversarialRules and data.adversarialRules.strip():
        adv = f"\n【用户红队对抗规则（必须遵守）】：{data.adversarialRules.strip()}"
    system_prompt = (
        "你是创世台的'积木调度官'。当前有 4 块设定积木：worldviewBlock(世界观)、protagonistBlock(主角)、"
        "antagonistBlock(对手)、narrativeTone(叙事色调)。用户会给出一句修改指令。\n"
        "请判断该指令意图修改哪些积木（可一个或多个），仅重写被影响的积木，未受影响的积木在返回中保持为 null。"
        "重写时必须与其余积木保持设定自洽，绝不能引入唯心套路或廉价拼贴。"
        "modifiedBlocks 必须准确列出你实际修改的积木 ID。\n"
        + target_guard
        + ANTI_SLOP_CONSTRAINT
    )
    user_prompt = (
        f"【当前积木】\nworldviewBlock：{data.worldviewBlock}\nprotagonistBlock：{data.protagonistBlock}\n"
        f"antagonistBlock：{data.antagonistBlock}\nnarrativeTone：{data.narrativeTone}\n\n"
        f"【用户修改指令】：{instruction}{adv}"
    )
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=TweakBlocksResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="tweak_fusion_blocks",
        instructor_retries=1,
    )


async def run_generate_storyboard(
    data: StoryboardInput,
    request: Request,
    *,
    enforce_rate_limit: bool,
):
    if enforce_rate_limit:
        await ensure_rate_limit(request, "/api/py/generate-storyboard")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)
    d = data.selectedDirection
    logger.info("generate_storyboard ip=%s model=%s scenes=%s", get_client_ip(request), model, data.sceneCount)

    adv = ""
    if data.adversarialRules and data.adversarialRules.strip():
        adv = f"\n【用户红队对抗规则（必须遵守）】：{data.adversarialRules.strip()}"
    system_prompt = (
        f"你是顶尖的小说分镜编剧。基于给定的融合设定，设计 {data.sceneCount} 个连贯递进的开篇故事板分镜。"
        "每个分镜给出：序号(sceneNumber)、标题(sceneTitle)、核心情节走向与爽点/爆点(plotOutline)、"
        "张力曲线(tensionLevel)、画面感与环境意象指示(visualCues)。"
        "分镜之间要有清晰的张力递进与因果勾连，为后续正文铺好骨架。\n"
        + ANTI_SLOP_CONSTRAINT
    )
    user_prompt = (
        f"【融合设定】\n方向：{d.title}\n世界观：{d.worldviewBlock}\n主角：{d.protagonistBlock}\n"
        f"对手：{d.antagonistBlock}\n叙事色调：{d.narrativeTone}{adv}\n\n请输出 {data.sceneCount} 个分镜。"
    )
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=StoryboardResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="generate_storyboard",
    )


@app.post("/api/py/generate-storyboard")
async def generate_storyboard(data: StoryboardInput, request: Request):
    return await run_generate_storyboard(data, request, enforce_rate_limit=True)


@app.post("/api/py/stream-storyboard")
async def stream_storyboard(data: StoryboardInput, request: Request):
    await ensure_rate_limit(request, "/api/py/stream-storyboard")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)
    client = build_openai_client(api_key, data.baseUrl, timeout=STREAM_TIMEOUT_SECONDS)
    d = data.selectedDirection
    logger.info("stream_storyboard ip=%s model=%s scenes=%s", get_client_ip(request), model, data.sceneCount)

    adv = ""
    if data.adversarialRules and data.adversarialRules.strip():
        adv = f"\n【用户红队对抗规则（必须遵守）】：{data.adversarialRules.strip()}"

    system_prompt = (
        f"你是顶尖的小说分镜编剧。请基于融合设定生成 {data.sceneCount} 个连贯递进的开篇分镜。"
        "必须严格按以下模板输出，并完整输出全部分镜：\n"
        "[SCENE-1]\n"
        "title: <分镜标题>\n"
        "plot: <核心情节走向与爆点>\n"
        "tension: <张力曲线>\n"
        "visual: <画面意象>\n"
        "[/SCENE-1]\n"
        "...\n"
        f"[SCENE-{data.sceneCount}] ... [/SCENE-{data.sceneCount}]\n"
        "严禁输出 Markdown 代码块、解释、前言或额外字段。"
        + ANTI_SLOP_CONSTRAINT
    )
    user_prompt = (
        f"【融合设定】\n方向：{d.title}\n世界观：{d.worldviewBlock}\n主角：{d.protagonistBlock}\n"
        f"对手：{d.antagonistBlock}\n叙事色调：{d.narrativeTone}{adv}\n\n"
        "请开始输出分镜。"
    )

    async def event_generator():
        stream_buffer = ""
        try:
            stream = await client.chat.completions.create(
                model=model,
                temperature=data.temperature,
                max_tokens=2200,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                content = delta.content if delta else None
                if content:
                    stream_buffer += content
                    yield sse_event("delta", {"text": content})

            scenes = parse_storyboard_scene_blocks(stream_buffer, data.sceneCount)
            if not scenes:
                fallback = await run_generate_storyboard(data, request, enforce_rate_limit=False)
                scenes = [scene.model_dump() for scene in fallback.scenes]
            yield sse_event("done", {"ok": True, "scenes": scenes})
        except ApiError as exc:
            logger.warning("stream_storyboard api error ip=%s model=%s code=%s", get_client_ip(request), model, exc.code)
            yield sse_event("error", {"code": exc.code, "message": exc.message})
        except Exception as exc:
            logger.warning("stream_storyboard failed ip=%s model=%s err=%s", get_client_ip(request), model, exc.__class__.__name__)
            _, code, message = classify_openai_error(exc)
            yield sse_event("error", {"code": code, "message": message})

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/py/stream-scene-text")
async def stream_scene_text(data: SceneTextInput, request: Request):
    await ensure_rate_limit(request, "/api/py/stream-scene-text")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)
    client = build_openai_client(api_key, data.baseUrl, timeout=STREAM_TIMEOUT_SECONDS)
    scene = data.currentScene
    logger.info("stream_scene_text ip=%s model=%s scene=%s", get_client_ip(request), model, scene.sceneNumber)

    adv = ANTI_SLOP_CONSTRAINT
    if data.adversarialRules and data.adversarialRules.strip():
        adv += f"\n【用户红队对抗规则（必须遵守）】：{data.adversarialRules.strip()}"

    system_prompt = (
        "你是一位文字极具颗粒度的小说家。请根据给定的设定积木与当前分镜大纲创作小说正文。\n"
        + adv
        + "\n直接输出正文，不要任何前言、标题或解释。"
    )
    user_prompt = build_scene_user_prompt(data)

    async def event_generator():
        try:
            stream = await client.chat.completions.create(
                model=model,
                temperature=data.temperature,
                max_tokens=3200,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                content = delta.content if delta else None
                if content:
                    yield sse_event("delta", {"text": content})

            yield sse_event("done", {"ok": True})
        except Exception as exc:
            logger.warning("stream_scene_text failed ip=%s model=%s err=%s", get_client_ip(request), model, exc.__class__.__name__)
            _, code, message = classify_openai_error(exc)
            yield sse_event("error", {"code": code, "message": message})

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/py/split-recommend")
async def split_recommend(data: SplitRecommendInput, request: Request):
    await ensure_rate_limit(request, "/api/py/split-recommend")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)

    # 截断到前 ~2 万字，控制单次结构化调用规模；保持与前端段落下标严格对齐。
    paragraphs: list[str] = []
    total = 0
    for raw in data.paragraphs:
        para = raw.strip()
        if not para:
            continue
        if paragraphs and total + len(para) > MAX_SPLIT_RECOMMEND_CHARS:
            break
        paragraphs.append(para)
        total += len(para)
    if not paragraphs:
        raise ApiError(status_code=400, code="invalid_request", message="正文内容不能为空。")

    # AC2：日志一律使用脱敏后的 Key（sk-***[后四位]），严禁明文外泄。
    logger.info(
        "split_recommend ip=%s model=%s paragraphs=%s chars=%s key=%s",
        get_client_ip(request), model, len(paragraphs), total, mask_api_key(api_key),
    )

    numbered = "\n".join(f"[{idx}] {p}" for idx, p in enumerate(paragraphs))
    last_index = len(paragraphs) - 1
    system_prompt = (
        "你是一位资深的中文小说结构编辑。下面是一段“分章失败、被当作单一长章”的小说正文，"
        "已按自然段拆分并以 [序号] 前缀编号（序号 0 基）。\n"
        "请基于语义收束、场景转换、时间跳跃或视角切换，找出最合理的若干处“章节切分点”。\n"
        "对每一处推荐给出：\n"
        "1. splitParagraphIndex：在“该序号自然段之后”切开（此段归上半章，下一段进入下半章）；必须是输入中真实存在的序号。\n"
        "2. suggestedTitle：切分出的“下半章”推荐标题（简洁、具体、贴合该段起始内容）。\n"
        "3. reason：为何在此切分（一句话，具象克制）。\n"
        "约束：按序号从小到大返回；只在确有清晰语义边界处推荐，宁缺毋滥；"
        f"序号必须落在 0..{last_index} 范围内，且不要在最后一段（{last_index}）之后切分；"
        "若全文确实没有明显边界，请返回空列表。\n"
        + ANTI_SLOP_CONSTRAINT
    )
    user_prompt = f"小说名：{data.novelName or '（未命名）'}\n\n【按自然段编号的正文】\n{numbered}"
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=SplitRecommendResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="split_recommend",
        instructor_retries=1,
    )

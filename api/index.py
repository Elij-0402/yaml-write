import asyncio
import ipaddress
import json
import logging
import os
import random
import re
import time
from collections import defaultdict, deque
from typing import Deque, Optional
from urllib.parse import urlsplit, urlunsplit

import instructor
try:  # instructor.exceptions 在新版（1.15+）已废弃并将移除；优先 instructor.core，回退兼容旧布局。
    from instructor.core import InstructorRetryException
except ImportError:
    from instructor.exceptions import InstructorRetryException
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
from pydantic import ValidationError

from api.schemas import (
    ArcMapInput,
    BookDirectInput,
    BookReduceInput,
    ChapterMapSummaryResponse,
    FusionDirectionsInput,
    FusionDirectionsResponse,
    MAX_ARC_CONTENT_CHARS,
    MAX_DIRECT_INPUT_CHARS,
    NovelDNACardResponse,
    RepairSettingGapsInput,
    RepairSettingGapsResponse,
    SceneTextInput,
    SelectedDirection,
    SplitRecommendInput,
    SplitRecommendResponse,
    TweakBlocksInput,
    TweakBlocksResponse,
)
from api.prompts import (
    ANTI_SLOP_CONSTRAINT,
    TONE_GUIDE,
    NON_COLD_TONE_RELEASE,
    FOUR_LAYER_DNA_GUIDE,
    MAX_SCENE_CONTEXT_CHARS,
    sanitize_text,
    trim_text_tail,
    build_scene_user_prompt,
    build_tone_clause,
    build_repair_prompts,
    build_book_direct_prompts,
    build_book_reduce_prompts,
    build_arc_map_prompts,
)

logger = logging.getLogger("novel_fusion_api")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)

app = FastAPI(docs_url="/api/py/docs", openapi_url="/api/py/openapi.json")

REQUEST_TIMEOUT_SECONDS = 25.0
LONG_REQUEST_TIMEOUT_SECONDS = 120.0  # 重步骤（整本直提 / reduce / 弧窗 / 换皮 / 补洞）面向本地/非 Vercel 后端（决策 A），放宽超时
STREAM_TIMEOUT_SECONDS = 60.0
MAX_PARSE_RETRIES = 2
MAX_SPLIT_RECOMMEND_CHARS = 20000
RATE_LIMIT_RULES = {
    "/api/py/extract-arc-map": (60, 120),
    "/api/py/extract-book-direct": (60, 10),
    "/api/py/extract-book-reduce": (60, 10),
    "/api/py/generate-fusion-directions": (60, 8),
    "/api/py/repair-setting-gaps": (60, 8),
    "/api/py/tweak-fusion-blocks": (60, 20),
    "/api/py/stream-scene-text": (60, 12),
    "/api/py/split-recommend": (60, 20),
}

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
# 节流式 GC：每 ~120s 顺带裁剪并删除已空的限流桶，避免唯一 IP 的桶无界堆积（内存泄漏）。
# 用所有规则的最大窗口作裁剪口径，保守起见绝不误删未过期项。
_RL_GC_INTERVAL = 120.0
_RL_MAX_WINDOW = max([w for w, _ in RATE_LIMIT_RULES.values()] + [60])
_last_rl_gc = 0.0


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


# 结构化解析失败（模型没按 JSON / tool schema 稳定返回）的统一友好文案。
_STRUCTURED_FAIL_MSG = (
    "模型未能稳定产出结构化结果（可能不支持结构化输出），"
    "建议更换为支持结构化输出的 Chat 模型（如 deepseek-chat）。"
)


def classify_openai_error(exc: Exception) -> tuple[int, str, str]:
    # instructor 重试异常先解包：其根因可能是 OpenAI SDK 异常（如 BadRequest=模型不支持 tools / Auth 失效），
    # 也可能是模型没按结构化格式返回导致的 pydantic 校验失败。前者沿用下方精确分类，后者归 422（可重试）。
    if isinstance(exc, InstructorRetryException):
        cause = exc.__cause__
        if cause is not None and cause is not exc:
            return classify_openai_error(cause)
        return 422, "structured_parse_failed", _STRUCTURED_FAIL_MSG
    if isinstance(exc, ValidationError):
        return 422, "structured_parse_failed", _STRUCTURED_FAIL_MSG
    if isinstance(exc, json.JSONDecodeError):
        # 模型偶发吐非法/截断 JSON（如 cheap flash 在补洞时）：与 pydantic 校验失败同类，归可重试的 422，
        # 让 run_structured 退避重试救回，而不是落到下方不可重试的 500 兜底。
        # 亦覆盖 InstructorRetryException.__cause__ 解包后为 JSONDecodeError（非 ValidationError）的情形。
        return 422, "structured_parse_failed", _STRUCTURED_FAIL_MSG
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
        global _last_rl_gc
        if now - _last_rl_gc > _RL_GC_INTERVAL:
            _last_rl_gc = now
            for key in list(_rate_limit_buckets.keys()):
                bucket = _rate_limit_buckets[key]
                while bucket and bucket[0] < now - _RL_MAX_WINDOW:
                    bucket.popleft()
                if not bucket:
                    del _rate_limit_buckets[key]
        queue = _rate_limit_buckets[client_key]
        cutoff = now - window_seconds
        while queue and queue[0] < cutoff:
            queue.popleft()
        if len(queue) >= max_requests:
            raise ApiError(status_code=429, code="rate_limited", message="请求频率过高，请稍后再试。")
        queue.append(now)


def sse_event(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def pick_instructor_mode(base_url: str, model: str) -> instructor.Mode:
    """选择 instructor 结构化模式：DeepSeek 系（直连或经硅基流动）的 function-calling 不稳定，
    改用 JSON 模式（response_format）更可靠；OpenAI / Gemini 等原生支持 tools，保持默认 TOOLS。"""
    probe = f"{base_url} {model}".lower()
    if "deepseek" in probe:
        return instructor.Mode.JSON
    return instructor.Mode.TOOLS


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
    timeout: float = REQUEST_TIMEOUT_SECONDS,
):
    """Shared structured-extraction call: instructor + transient retry + friendly errors."""
    client = instructor.from_openai(
        build_openai_client(api_key, base_url, timeout=timeout),
        mode=pick_instructor_mode(base_url, model),
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
            # 422=模型结构化输出偶发不合规（temperature 抖动），与瞬时 5xx/429 一并给有限次重试。
            should_retry = status_code in {422, 429, 502, 503, 504} and attempt < MAX_PARSE_RETRIES
            if should_retry:
                await asyncio.sleep((2 ** attempt) + random.uniform(0.1, 0.4))
                continue
            logger.warning(
                "%s failed ip=%s model=%s status=%s err=%s msg=%s",
                label, get_client_ip(request), model, status_code,
                exc.__class__.__name__, scrub_sensitive(str(exc))[:200],
            )
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


@app.post("/api/py/extract-book-reduce")
async def extract_book_reduce(data: BookReduceInput, request: Request):
    await ensure_rate_limit(request, "/api/py/extract-book-reduce")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)

    logger.info("extract_book_reduce ip=%s model=%s chapters=%s", get_client_ip(request), model, len(data.mapSummaries))

    system_prompt, user_prompt = build_book_reduce_prompts(data)
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=NovelDNACardResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="extract_book_reduce",
        instructor_retries=1, timeout=LONG_REQUEST_TIMEOUT_SECONDS,
    )


@app.post("/api/py/extract-book-direct")
async def extract_book_direct(data: BookDirectInput, request: Request):
    """小档「整本直提」：整本（或大块）净化文本一次喂入 → 直接产 4 层 DNA，跳过逐章 map。"""
    await ensure_rate_limit(request, "/api/py/extract-book-direct")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    content = sanitize_text(data.content)
    if not content:
        raise ApiError(status_code=400, code="invalid_request", message="正文内容不能为空。")
    if len(content) > MAX_DIRECT_INPUT_CHARS:
        content = content[:MAX_DIRECT_INPUT_CHARS]
    validate_llm_creds(api_key, model, data.temperature)
    logger.info("extract_book_direct ip=%s model=%s content_chars=%s", get_client_ip(request), model, len(content))

    system_prompt, user_prompt = build_book_direct_prompts(data)
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=NovelDNACardResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="extract_book_direct",
        instructor_retries=1, timeout=LONG_REQUEST_TIMEOUT_SECONDS,
    )


@app.post("/api/py/extract-arc-map")
async def extract_arc_map(data: ArcMapInput, request: Request):
    """中/大档「弧窗 map」：若干连续章节拼接成的弧文本 → 一条 ChapterMapSummary。"""
    await ensure_rate_limit(request, "/api/py/extract-arc-map")
    title = sanitize_text(data.title)
    content = sanitize_text(data.content)
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    if not title or not content:
        raise ApiError(status_code=400, code="invalid_request", message="区间标识与内容不能为空。")
    if len(content) > MAX_ARC_CONTENT_CHARS:
        content = content[:MAX_ARC_CONTENT_CHARS]
    validate_llm_creds(api_key, model, data.temperature)
    logger.info("extract_arc_map ip=%s model=%s content_chars=%s", get_client_ip(request), model, len(content))

    system_prompt, user_prompt = build_arc_map_prompts(data)
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=ChapterMapSummaryResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="extract_arc_map",
        instructor_retries=1, timeout=LONG_REQUEST_TIMEOUT_SECONDS,
    )


@app.post("/api/py/generate-fusion-directions")
async def generate_fusion_directions(data: FusionDirectionsInput, request: Request):
    await ensure_rate_limit(request, "/api/py/generate-fusion-directions")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)

    engine = data.engineCard
    if not engine or not engine.structureSkeleton:
        raise ApiError(
            status_code=400,
            code="missing_engine_card",
            message="缺少骨架引擎卡（需 4 层 DNA 的结构骨架）。请先对骨架书完成 DNA 提取。",
        )
    skin = data.skinSource
    mode = data.mode or ("cross" if (skin and (skin.novelName or skin.themeSkin)) else "self")
    logger.info("generate_fusion_directions ip=%s model=%s mode=%s freedom=%s beats=%s", get_client_ip(request), model, mode, data.freedom, len(engine.structureSkeleton))

    beats = "\n".join(
        f"- {b.function}：{b.summary}" for b in engine.structureSkeleton if (b.function or "").strip()
    ) or "（结构骨架为空）"

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

    if data.freedom:
        # 0→1 原创 / 自由重组分支：DNA 当灵感调色板而非固定骨架，用户意图压过源书节拍，
        # 松绑「节拍不变」硬规则、软化反套路对文风的压平，并抬高 variation（temperature 下限 0.9）。
        system_prompt = (
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
        user_prompt = (
            f"【可借用的引擎灵感（仅供参考，可自由取舍 / 重组 / 另起，非约束）】\n来源：{engine.novelName or '（未命名）'}\n"
            f"结构功能节拍：\n{beats}\n编排节奏参考：{engine.pacingSyuzhet or '（未提供）'}\n\n"
            f"【创作主轴（最高权重）与题材调色板】\n{skin_block}{extra}\n\n"
            "请以用户意图为主轴、引擎仅作灵感，产出 3 个真正原创、彼此迥异的开篇立项方向。"
        )
        temperature = min(1.5, max(data.temperature, 0.9))
    else:
        system_prompt = (
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
        user_prompt = (
            f"【骨架引擎（迁移不变量）】\n来源：{engine.novelName or '（未命名）'}\n"
            f"结构功能节拍序列：\n{beats}\n编排节奏：{engine.pacingSyuzhet or '（未提供）'}\n\n"
            f"【新题材皮（替换目标）】\n{skin_block}{extra}\n\n"
            "请输出 3 个换皮嫁接方向。"
        )
        temperature = data.temperature
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=FusionDirectionsResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=temperature, request=request, label="generate_fusion_directions",
        instructor_retries=2, timeout=LONG_REQUEST_TIMEOUT_SECONDS,
    )


@app.post("/api/py/repair-setting-gaps")
async def repair_setting_gaps(data: RepairSettingGapsInput, request: Request):
    """补洞：逐结构节拍核对新题材能否支撑，定位断裂点并补入自洽事件 / 设定（质量护城河）。"""
    await ensure_rate_limit(request, "/api/py/repair-setting-gaps")
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)
    validate_llm_creds(api_key, model, data.temperature)
    logger.info("repair_setting_gaps ip=%s model=%s freedom=%s beats=%s", get_client_ip(request), model, data.freedom, len(data.structureSkeleton))

    system_prompt, user_prompt = build_repair_prompts(data)
    return await run_structured(
        api_key=api_key, base_url=data.baseUrl, model=model,
        response_model=RepairSettingGapsResponse,
        system_prompt=system_prompt, user_prompt=user_prompt,
        temperature=data.temperature, request=request, label="repair_setting_gaps",
        instructor_retries=1, timeout=LONG_REQUEST_TIMEOUT_SECONDS,
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

    tone_clause = build_tone_clause(data.tone)

    system_prompt = (
        "你是一位文字极具颗粒度的小说家。请根据给定的设定积木与当前分镜大纲创作小说正文。\n"
        + adv
        + tone_clause
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
                # 客户端断开（停止生成 / 关页）后立即停止从上游拉流，省 BYOK token。
                if await request.is_disconnected():
                    break
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

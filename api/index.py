import asyncio
import ipaddress
import json
import logging
import os
import random
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
from pydantic import BaseModel, Field

from api.schemas import ChapterAnalysis, GenerationInput, OutlineInput

logger = logging.getLogger("novel_fusion_api")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)

app = FastAPI(docs_url="/api/py/docs", openapi_url="/api/py/openapi.json")

REQUEST_TIMEOUT_SECONDS = 25.0
STREAM_TIMEOUT_SECONDS = 60.0
MAX_PARSE_RETRIES = 2
MAX_CHAPTER_CONTENT_CHARS = 30000
MAX_OUTLINE_INPUT_CHARS = 100000
MAX_GENERATION_INPUT_CHARS = 120000
RATE_LIMIT_RULES = {
    "/api/py/parse-chapter": (60, 30),
    "/api/py/generate-outline": (60, 12),
    "/api/py/generate-text": (60, 12),
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


class ApiError(Exception):
    def __init__(self, *, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class ParseChapterInput(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    content: str = Field(..., min_length=1, max_length=MAX_CHAPTER_CONTENT_CHARS)
    apiKey: str = Field(..., min_length=1, max_length=512)
    baseUrl: str = Field(..., min_length=1, max_length=512)
    model: str = Field(..., min_length=1, max_length=200)
    temperature: float = Field(default=0.7, ge=0.0, le=1.5)


def error_payload(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


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


def validate_generation_input(data: OutlineInput | GenerationInput) -> None:
    if not data.apiKey.strip():
        raise ApiError(status_code=400, code="invalid_request", message="API Key 不能为空。")
    if not data.model.strip():
        raise ApiError(status_code=400, code="invalid_request", message="模型名称不能为空。")
    if not (0 <= data.temperature <= 1.5):
        raise ApiError(status_code=400, code="invalid_temperature", message="temperature 必须在 0 到 1.5 之间。")

    if isinstance(data, OutlineInput):
        if not data.fusionPrompt.strip():
            raise ApiError(status_code=400, code="invalid_request", message="融合指令不能为空。")
        if len(data.selectedChapters) == 0:
            raise ApiError(status_code=400, code="invalid_request", message="至少需要一个已解析章节。")
        if len(str(data.selectedChapters)) > MAX_OUTLINE_INPUT_CHARS:
            raise ApiError(status_code=413, code="input_too_large", message="章节分析输入过大，请减少样本后重试。")
    else:
        if not data.fusionPrompt.strip():
            raise ApiError(status_code=400, code="invalid_request", message="融合指令不能为空。")
        if not data.outline.strip():
            raise ApiError(status_code=400, code="invalid_request", message="大纲不能为空。")
        if len(data.outline) > MAX_GENERATION_INPUT_CHARS:
            raise ApiError(status_code=413, code="input_too_large", message="大纲输入过大，请精简后重试。")


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


def build_openai_client(api_key: str, base_url: str, timeout: float) -> AsyncOpenAI:
    normalized_base_url = validate_base_url(base_url)
    return AsyncOpenAI(
        api_key=api_key.strip(),
        base_url=normalized_base_url,
        timeout=timeout,
        max_retries=0,
    )


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return JSONResponse(status_code=exc.status_code, content=error_payload(exc.code, exc.message))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content=error_payload("invalid_request", f"参数校验失败：{exc.errors()[0].get('msg', '请求参数不合法。')}"),
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    logger.exception("unhandled error endpoint=%s ip=%s", request.url.path, get_client_ip(request))
    return JSONResponse(status_code=500, content=error_payload("internal_error", "服务暂时不可用，请稍后重试。"))


@app.post("/api/py/parse-chapter")
async def parse_chapter(data: ParseChapterInput, request: Request):
    await ensure_rate_limit(request, "/api/py/parse-chapter")
    title = sanitize_text(data.title)
    content = sanitize_text(data.content)
    model = sanitize_text(data.model)
    api_key = sanitize_text(data.apiKey)

    if not title:
        raise ApiError(status_code=400, code="invalid_request", message="章节标题不能为空。")
    if not content:
        raise ApiError(status_code=400, code="invalid_request", message="章节内容不能为空。")
    if len(content) > MAX_CHAPTER_CONTENT_CHARS:
        raise ApiError(
            status_code=413,
            code="content_too_large",
            message=f"章节内容超长（上限 {MAX_CHAPTER_CONTENT_CHARS} 字符），请先切分后再解析。",
        )
    if not model:
        raise ApiError(status_code=400, code="invalid_request", message="模型名称不能为空。")
    if not api_key:
        raise ApiError(status_code=400, code="invalid_request", message="API Key 不能为空。")

    client = instructor.from_openai(
        build_openai_client(api_key, data.baseUrl, timeout=REQUEST_TIMEOUT_SECONDS)
    )
    logger.info("parse_chapter ip=%s model=%s content_chars=%s", get_client_ip(request), model, len(content))

    system_prompt = (
        "你是一个专业的小说分析助手。请分析给定的章节标题与内容，提取出世界观设定、出场角色列表、人物关系网络、核心故事骨架以及叙事风格与基调。\n"
        "对于出场角色，必须提取出详细的名字、性格、外貌特征、核心矛盾冲突以及出场章节。\n"
        "对于人物关系，必须提取出角色A、角色B以及关系描述。"
    )
    user_prompt = f"章节标题: {title}\n\n章节内容:\n{content}"

    for attempt in range(MAX_PARSE_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                response_model=ChapterAnalysis,
                temperature=data.temperature,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )
            return response
        except Exception as exc:
            status_code, code, message = classify_openai_error(exc)
            should_retry = status_code in {429, 502, 503, 504} and attempt < MAX_PARSE_RETRIES
            if should_retry:
                delay = (2 ** attempt) + random.uniform(0.1, 0.4)
                await asyncio.sleep(delay)
                continue
            logger.warning("parse_chapter failed ip=%s model=%s err=%s", get_client_ip(request), model, exc.__class__.__name__)
            raise ApiError(status_code=status_code, code=code, message=message) from exc


@app.post("/api/py/generate-outline")
async def generate_outline(data: OutlineInput, request: Request):
    await ensure_rate_limit(request, "/api/py/generate-outline")
    validate_generation_input(data)
    client = build_openai_client(data.apiKey, data.baseUrl, timeout=STREAM_TIMEOUT_SECONDS)
    model = data.model.strip()
    logger.info("generate_outline ip=%s model=%s chapters=%s", get_client_ip(request), model, len(data.selectedChapters))

    system_prompt = (
        "你是一个顶尖的网文作家和小说创意架构师。你擅长将不同的故事设定、角色和剧情线进行完美、有机的融合，创造出令人惊叹的新创意大纲。\n"
        "你的任务是根据用户提供的多部小说/章节解析信息以及融合指令，生成一份极具创意、条理清晰的【融合小说新大纲】。\n"
        "新大纲必须采用 Markdown 格式，且包含以下内容：\n"
        "1. 新小说的核心世界观与设定（融合两者的闪光点）\n"
        "2. 融合后的主要角色表及核心人物关系\n"
        "3. 全新的核心冲突与故事主线\n"
        "4. 细化到具体前几章的分章剧情大纲与爆点设计\n\n"
        "请确保生成的内容充满想象力，逻辑自洽，节奏感极佳，直接输出 Markdown 文本，不要有任何无关的前言或后记。"
    )

    chapters_context = ""
    for idx, chap in enumerate(data.selectedChapters):
        chapters_context += f"--- 章节样本 {idx + 1} ---\n"
        chapters_context += f"世界观: {chap.get('worldview', '')}\n"
        chapters_context += f"核心骨架: {chap.get('plotSkeleton', '')}\n"
        chapters_context += f"风格: {chap.get('style', '')}\n"
        chapters_context += "出场角色:\n"
        for char in chap.get("characters", []):
            chapters_context += f"- {char.get('name')}: 性格={char.get('personality')}, 外貌={char.get('appearance')}, 冲突={char.get('coreConflict')}\n"
        chapters_context += "角色关系:\n"
        for rel in chap.get("relationships", []):
            chapters_context += f"- {rel.get('roleA')} 与 {rel.get('roleB')}: {rel.get('description')}\n"
        chapters_context += "\n"

    user_prompt = (
        f"下面是供你融合的现有小说章节结构化解析信息：\n\n"
        f"{chapters_context}\n"
        f"作家的融合指令/要求如下：\n"
        f"【{data.fusionPrompt}】\n\n"
        f"请根据上述信息，为我生成精美的融合大纲。"
    )

    async def event_generator():
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
                    yield sse_event("delta", {"text": content})

            yield sse_event("done", {"ok": True})
        except Exception as exc:
            logger.warning("generate_outline failed ip=%s model=%s err=%s", get_client_ip(request), model, exc.__class__.__name__)
            _, code, message = classify_openai_error(exc)
            yield sse_event("error", {"code": code, "message": message})

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/py/generate-text")
async def generate_text(data: GenerationInput, request: Request):
    await ensure_rate_limit(request, "/api/py/generate-text")
    validate_generation_input(data)
    client = build_openai_client(data.apiKey, data.baseUrl, timeout=STREAM_TIMEOUT_SECONDS)
    model = data.model.strip()
    logger.info("generate_text ip=%s model=%s outline_chars=%s", get_client_ip(request), model, len(data.outline))

    system_prompt = (
        "你是一个拥有十余年网文写作经验的白金作家，擅长细腻的心理描写、宏大的战斗场面、精妙的对话以及让人欲罢不能的爽点设计。\n"
        "你的任务是根据作家微调后的【融合新大纲】和【融合指令】，开始创作小说正文的第一章（或全新独立章节）。\n"
        "写作要求：\n"
        "1. 字数尽量丰满（建议生成 2000-3000 字左右的高水准正文），展开细节，描写画面感要强，避免平铺直叙地解释设定。\n"
        "2. 将大纲中的核心冲突、性格张力通过对话、行动和场景氛围真实表现出来。\n"
        "3. 直接输出小说的正式正文内容，不要有任何多余的开场白或自我介绍。"
    )

    user_prompt = (
        f"微调后的融合新大纲如下：\n\n"
        f"{data.outline}\n\n"
        f"当初的融合指令/要求：\n"
        f"【{data.fusionPrompt}】\n\n"
        f"请开始动笔创作这篇融合小说的第一章（或核心章节）正文。"
    )

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
            logger.warning("generate_text failed ip=%s model=%s err=%s", get_client_ip(request), model, exc.__class__.__name__)
            _, code, message = classify_openai_error(exc)
            yield sse_event("error", {"code": code, "message": message})

    return StreamingResponse(event_generator(), media_type="text/event-stream")

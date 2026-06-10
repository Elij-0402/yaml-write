"""各环节适配器:把黄金夹具(请求体 dict)喂给真实 builder 渲染 prompt,
再经 run_structured 生成产出。render_prompt 是纯函数(可离线测);generate_output 发网络。
extract 环节默认用 direct 路由(小档),夹具即截断书文。"""
from typing import Any

from api.prompts import (
    build_book_direct_prompts,
    build_fusion_directions_prompts,
    resolve_fusion_temperature,
    build_repair_prompts,
    build_scene_user_prompt,
    build_scene_system_prompt,
)
from api.schemas import (
    BookDirectInput, FusionDirectionsInput, RepairSettingGapsInput, SceneTextInput,
    NovelDNACardResponse, FusionDirectionsResponse, RepairSettingGapsResponse,
)

# 评测无凭证;构造 Pydantic 输入时填占位 creds(prompt 构造不读它们)。
_PLACEHOLDER_CREDS = {"apiKey": "x", "baseUrl": "x", "model": "m"}


STAGE_SPECS = {
    "extract": {"input": BookDirectInput, "response": NovelDNACardResponse,
                "builder": build_book_direct_prompts},
    "directions": {"input": FusionDirectionsInput, "response": FusionDirectionsResponse,
                   "builder": build_fusion_directions_prompts},
    "repair": {"input": RepairSettingGapsInput, "response": RepairSettingGapsResponse,
               "builder": build_repair_prompts},
    # prose 走 SSE,产出是纯文本;单独处理(见 generate_output)。
    "prose": {"input": SceneTextInput, "response": None, "builder": None},
}


def _build_input(stage: str, fixture: dict):
    spec = STAGE_SPECS[stage]
    return spec["input"](**{**fixture, **_PLACEHOLDER_CREDS})


def render_prompt(stage: str, fixture: dict) -> tuple[str, str]:
    """纯渲染:夹具 → (system, user)。prose 环节复用真实 system/user builder。"""
    if stage == "prose":
        data = _build_input("prose", fixture)
        return build_scene_system_prompt(data), build_scene_user_prompt(data)
    data = _build_input(stage, fixture)
    return STAGE_SPECS[stage]["builder"](data)


def _creds_into(fixture: dict, cfg) -> dict:
    d = dict(fixture)
    d["apiKey"] = cfg.api_key
    d["baseUrl"] = cfg.base_url
    d["model"] = cfg.gen_model
    return d


class _FakeRequest:
    """run_structured 只在出错日志里用 request 取 IP;提供最小桩。"""
    class _C:
        host = "eval"
    client = _C()
    headers: dict = {}
    url = type("U", (), {"path": "/eval"})()


async def generate_output(stage: str, fixture: dict, cfg) -> dict:
    """发真实网络:经 run_structured 生成结构化产出,返回 model_dump() dict。
    prose 环节走非流式 chat 收齐全文,返回 {'text': ...}。"""
    from api.index import run_structured
    payload = _creds_into(fixture, cfg)
    if stage == "prose":
        text = await _gen_prose(payload, cfg)
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


async def _gen_prose(payload: dict, cfg) -> str:
    """复用真实 build_scene_system_prompt + build_scene_user_prompt,一次非流式 chat 收全文。"""
    from api.index import build_openai_client
    data = SceneTextInput(**payload)
    system = build_scene_system_prompt(data)
    user = build_scene_user_prompt(data)
    client = build_openai_client(cfg.api_key, cfg.base_url, timeout=120.0)
    resp = await client.chat.completions.create(
        model=cfg.gen_model, temperature=cfg.gen_temperature, max_tokens=3200,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return resp.choices[0].message.content or ""

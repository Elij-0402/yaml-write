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

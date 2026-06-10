"""编排单个 case:渲染 prompt → (缓存)生成 → 确定性检查 → (通过才)judge → 汇总。"""
import json
from typing import Callable, Optional

from evals.cases import CaseSpec
from evals.checks import check_dna_card, check_directions, check_repair, check_prose, CheckResult
from evals.stages import render_prompt, generate_output
from evals.judge import judge_votes
from evals.cache import Cache, output_key, judge_key, hash_text
from evals.rubrics import RUBRIC_VERSION

_CHECK_FN = {
    "extract": lambda o: check_dna_card(o),
    "directions": lambda o: check_directions(o),
    "repair": lambda o: check_repair(o),
    "prose": lambda o: check_prose(o.get("text", "")),
}


def _check(stage: str, output: dict) -> CheckResult:
    return _CHECK_FN[stage](output)


async def run_case(case: CaseSpec, *, cfg, gen: Callable = generate_output,
                   judge: Optional[Callable] = None, use_cache: bool = True,
                   cache_dir: str = "evals/cache", votes: int = 1) -> dict:
    system, user = render_prompt(case.stage, case.fixture)
    rendered = system + "\n----\n" + user
    fixture_hash = hash_text(json.dumps(case.fixture, ensure_ascii=False, sort_keys=True))
    cache = Cache(cache_dir) if use_cache else None

    okey = output_key(case.stage, rendered, fixture_hash, cfg.gen_model, cfg.gen_temperature)
    output = cache.get(okey) if cache else None
    if output is None:
        output = await gen(case.stage, case.fixture, cfg)
        if cache:
            cache.put(okey, output)

    chk = _check(case.stage, output)
    result = {
        "name": case.name, "stage": case.stage,
        "rendered_prompt": rendered,
        "output": output,
        "checks": {"passed": chk.passed, "failures": chk.failures},
        "scores": [],
        "overall": None,
    }
    if not chk.passed:
        return result  # 硬门失败 → 不浪费 judge

    judge_fn = judge or _default_judge
    produced_text = json.dumps(output, ensure_ascii=False, sort_keys=True)
    jkey = judge_key(RUBRIC_VERSION, cfg.judge_model, produced_text)
    cached_scores = cache.get(jkey) if cache else None
    if cached_scores is not None:
        result["scores"] = cached_scores
        return result

    scores = judge_fn(case.stage, output, case.reference, cfg=cfg, votes=votes)
    result["scores"] = [{"dimension": s.dimension, "score": s.score, "reason": s.reason} for s in scores]
    if cache:
        cache.put(jkey, result["scores"])
    return result


def _default_judge(stage, produced, reference, *, cfg, votes=1):
    client = _judge_client(cfg)
    return judge_votes(stage, produced, reference, client=client, model=cfg.judge_model,
                       temperature=cfg.judge_temperature, votes=votes)


def _judge_client(cfg):
    """同步 OpenAI 客户端(judge_output 是同步调用);复用后端 SSRF 校验。"""
    from openai import OpenAI
    from api.index import validate_base_url
    return OpenAI(api_key=cfg.api_key, base_url=validate_base_url(cfg.base_url),
                  timeout=60.0, max_retries=0)

"""LLM-as-judge:构造判官 prompt、调 DeepSeek(OpenAI 兼容)、解析结构化分数。
client 可注入,便于离线单测;低温 + 结构化 + 参照引导。"""
import json
import re
from dataclasses import dataclass
from typing import Any, Optional

from evals.rubrics import rubric_for, scale_text, RUBRIC_VERSION  # noqa: F401 (RUBRIC_VERSION 供调用方引用)


@dataclass
class JudgeScore:
    dimension: str
    score: int
    reason: str


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def build_judge_messages(stage: str, produced: Any, reference: Optional[Any]) -> list[dict]:
    r = rubric_for(stage)
    dims = "\n".join(f"- {d['key']}: {d['desc']}" for d in r["dimensions"])
    ref_block = ""
    if reference is not None:
        ref_block = f"\n【参照(判断贴合度用)】\n{json.dumps(reference, ensure_ascii=False)}\n"
    system = (
        f"你是严格的中文小说质量评审。针对「{r['title']}」环节,按下列维度逐项打分。{scale_text()}\n"
        f"维度:\n{dims}\n"
        '只输出 JSON,形如:{"scores":[{"dimension":"<key>","score":<0-4整数>,"reason":"<一句话>"}],"overall":"<一句话总评>"}。'
        "不要输出 JSON 以外的任何内容。"
    )
    user = f"{ref_block}\n【待评产出】\n{json.dumps(produced, ensure_ascii=False)}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_judge_json(raw: str) -> list[JudgeScore]:
    cleaned = _FENCE.sub("", (raw or "").strip())
    obj = json.loads(cleaned)
    out = []
    for s in obj.get("scores", []):
        score = int(s.get("score", 0))
        score = max(0, min(4, score))
        out.append(JudgeScore(dimension=str(s.get("dimension", "")), score=score,
                              reason=str(s.get("reason", ""))))
    return out


def judge_output(stage: str, produced: Any, reference: Optional[Any], *,
                 client, model: str, temperature: float) -> list[JudgeScore]:
    messages = build_judge_messages(stage, produced, reference)
    resp = client.chat.completions.create(
        model=model, temperature=temperature, messages=messages,
        response_format={"type": "json_object"},
    )
    content = resp.choices[0].message.content
    return parse_judge_json(content)


def judge_votes(stage: str, produced: Any, reference: Optional[Any], *,
                client, model: str, temperature: float, votes: int = 1) -> list[JudgeScore]:
    """votes>1 时多次打分,逐维度取中位数。"""
    if votes <= 1:
        return judge_output(stage, produced, reference, client=client, model=model, temperature=temperature)
    runs = [judge_output(stage, produced, reference, client=client, model=model, temperature=temperature)
            for _ in range(votes)]
    by_dim: dict[str, list[int]] = {}
    reasons: dict[str, str] = {}
    for run in runs:
        for sc in run:
            by_dim.setdefault(sc.dimension, []).append(sc.score)
            reasons.setdefault(sc.dimension, sc.reason)
    out = []
    for dim, scores in by_dim.items():
        scores.sort()
        median = scores[len(scores) // 2]
        out.append(JudgeScore(dimension=dim, score=median, reason=reasons[dim]))
    return out

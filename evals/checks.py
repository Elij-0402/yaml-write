"""确定性检查:免费、客观、永远先跑。任一硬门失败 → 不浪费 judge 调用。"""
from dataclasses import dataclass, field
from typing import Any

MIN_BEATS = 5
MIN_PROSE_CHARS = 200

# 与 api.prompts.ANTI_SLOP_CONSTRAINT 词表对齐(子集,纯检查用)。
SLOP_BLACKLIST = [
    "命运的齿轮", "那一刻", "逆天改命", "眼神变得坚定", "嘴角勾起一抹弧度",
    "仿佛整个世界都安静了", "空气仿佛凝固", "心中一紧", "缓缓睁开眼", "不知为何",
]


@dataclass
class CheckResult:
    passed: bool
    failures: list[str] = field(default_factory=list)
    slop_hits: int = 0


def _nonempty(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip())


def check_dna_card(card: dict) -> CheckResult:
    fails: list[str] = []
    beats = card.get("structureSkeleton") or []
    if len(beats) < MIN_BEATS:
        fails.append(f"结构节拍数 {len(beats)} < {MIN_BEATS}")
    for i, b in enumerate(beats):
        if not _nonempty(b.get("function")) or not _nonempty(b.get("summary")):
            fails.append(f"节拍[{i}] function/summary 空")
    for k in ("pacingSyuzhet", "themeSkin", "proseStyle"):
        if not _nonempty(card.get(k)):
            fails.append(f"{k} 空")
    return CheckResult(passed=not fails, failures=fails)


def check_directions(payload: dict) -> CheckResult:
    fails: list[str] = []
    dirs = payload.get("directions") or []
    if len(dirs) != 3:
        fails.append(f"方向数 {len(dirs)} != 3")
    for i, d in enumerate(dirs):
        for k in ("title", "concept", "worldviewBlock", "protagonistBlock",
                  "antagonistBlock", "narrativeTone", "transferNote"):
            if not _nonempty(d.get(k)):
                fails.append(f"方向[{i}].{k} 空")
    return CheckResult(passed=not fails, failures=fails)


def check_repair(payload: dict) -> CheckResult:
    fails: list[str] = []
    for k in ("worldviewBlock", "protagonistBlock", "antagonistBlock", "narrativeTone"):
        if not _nonempty(payload.get(k)):
            fails.append(f"{k} 空")
    return CheckResult(passed=not fails, failures=fails)


def check_prose(text: str) -> CheckResult:
    fails: list[str] = []
    text = text or ""
    if len(text) < MIN_PROSE_CHARS:
        fails.append(f"正文字数 {len(text)} < {MIN_PROSE_CHARS}")
    hits = sum(text.count(p) for p in SLOP_BLACKLIST)
    if hits:
        fails.append(f"反套路黑名单命中 {hits} 次")
    return CheckResult(passed=not fails, failures=fails, slop_hits=hits)

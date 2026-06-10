"""Case 装载:从 evals/cases/<stage>/*.json 读黄金夹具与可选参照。
每个 case 文件形如 {"fixture": {...请求体...}, "reference": {...可选...}}。"""
import json
import os
from dataclasses import dataclass
from typing import Any, Optional

CASES_DIR = os.path.join(os.path.dirname(__file__), "cases")


@dataclass
class CaseSpec:
    name: str
    stage: str
    fixture: dict
    reference: Optional[Any] = None


def load_cases(stage: str) -> list["CaseSpec"]:
    stage_dir = os.path.join(CASES_DIR, stage)
    if not os.path.isdir(stage_dir):
        return []
    out = []
    for fn in sorted(os.listdir(stage_dir)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(stage_dir, fn), encoding="utf-8") as fh:
            blob = json.load(fh)
        out.append(CaseSpec(name=fn[:-5], stage=stage,
                            fixture=blob["fixture"], reference=blob.get("reference")))
    return out

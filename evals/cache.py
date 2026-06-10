"""两层缓存键 + 文件读写。键变即重算(改 prompt → output_key 变 → 重跑生成)。"""
import hashlib
import json
import os
from typing import Any, Optional


def _h(*parts: str) -> str:
    return hashlib.sha256(" ".join(parts).encode("utf-8")).hexdigest()[:32]


def hash_text(text: str) -> str:
    return _h(text)


def output_key(stage: str, rendered_prompt: str, fixture_hash: str, model: str, temperature: float) -> str:
    return "out-" + _h(stage, rendered_prompt, fixture_hash, model, f"{temperature:.3f}")


def judge_key(rubric_version: str, judge_model: str, produced_text: str) -> str:
    return "judge-" + _h(rubric_version, judge_model, produced_text)


class Cache:
    def __init__(self, base_dir: str):
        self.base_dir = base_dir
        os.makedirs(base_dir, exist_ok=True)

    def _path(self, key: str) -> str:
        return os.path.join(self.base_dir, f"{key}.json")

    def get(self, key: str) -> Optional[Any]:
        path = self._path(key)
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def put(self, key: str, value: Any) -> None:
        with open(self._path(key), "w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False, indent=2)

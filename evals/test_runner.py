import asyncio
import tempfile
import unittest

from evals.runner import run_case, CaseSpec
from evals.judge import JudgeScore


def _good_dir():
    return {k: "x" for k in ("title", "concept", "worldviewBlock", "protagonistBlock",
                             "antagonistBlock", "narrativeTone", "transferNote")}


def _dir_fixture():
    """directions case 的最小有效夹具(engineCard 必备,否则 builder 按契约会抛)。"""
    return {
        "engineCard": {
            "novelName": "骨架书",
            "structureSkeleton": [{"function": "废柴受辱", "summary": "开局被欺"}],
            "pacingSyuzhet": "先抑后扬",
        },
        "skinSource": {"themeSkin": "美食"},
        "mode": "cross",
        "freedom": False,
    }


def _cfg(d):
    from evals.config import EvalConfig
    return EvalConfig(api_key="k", base_url="b", judge_model="m", judge_temperature=0.0,
                      gen_model="m", gen_temperature=0.7)


class RunnerTests(unittest.TestCase):
    def test_run_case_skips_judge_on_hard_fail(self) -> None:
        async def fake_gen(stage, fixture, cfg):
            return {"directions": []}  # check_directions 会失败

        judged = {"called": False}

        def fake_judge(stage, produced, reference, **kw):
            judged["called"] = True
            return []

        with tempfile.TemporaryDirectory() as d:
            case = CaseSpec(name="dir1", stage="directions", fixture=_dir_fixture(), reference=None)
            res = asyncio.run(run_case(case, cfg=_cfg(d), gen=fake_gen, judge=fake_judge, use_cache=False))
        self.assertFalse(res["checks"]["passed"])
        self.assertFalse(judged["called"])

    def test_run_case_judges_on_pass(self) -> None:
        async def fake_gen(stage, fixture, cfg):
            return {"directions": [_good_dir() for _ in range(3)]}

        def fake_judge(stage, produced, reference, **kw):
            return [JudgeScore("novelty", 3, "ok")]

        with tempfile.TemporaryDirectory() as d:
            case = CaseSpec(name="dir2", stage="directions", fixture=_dir_fixture(), reference=None)
            res = asyncio.run(run_case(case, cfg=_cfg(d), gen=fake_gen, judge=fake_judge, use_cache=False))
        self.assertTrue(res["checks"]["passed"])
        self.assertEqual(res["scores"][0]["score"], 3)

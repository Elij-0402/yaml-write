import unittest
from evals.cli import build_parser, plan_calls


class CliTests(unittest.TestCase):
    def test_parser_run(self) -> None:
        args = build_parser().parse_args(["run", "--stage", "directions", "--label", "x"])
        self.assertEqual(args.cmd, "run")
        self.assertEqual(args.stage, "directions")

    def test_dry_run_counts(self) -> None:
        # 2 个 directions case,单票 → 预计 2 次生成 + 2 次 judge
        plan = plan_calls(stages=["directions"], case_counts={"directions": 2}, votes=1)
        self.assertEqual(plan["generate"], 2)
        self.assertEqual(plan["judge"], 2)

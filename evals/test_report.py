import unittest
from evals.report import to_markdown, diff_reports


def _report(label, score):
    return {"label": label, "cases": [
        {"name": "c1", "stage": "directions",
         "checks": {"passed": True, "failures": []},
         "scores": [{"dimension": "novelty", "score": score, "reason": "r"}],
         "rendered_prompt": "P", "output": {}}
    ]}


class ReportTests(unittest.TestCase):
    def test_markdown_has_stage_and_score(self) -> None:
        md = to_markdown(_report("baseline", 3))
        self.assertIn("directions", md)
        self.assertIn("novelty", md)

    def test_diff_shows_delta(self) -> None:
        d = diff_reports(_report("baseline", 2), _report("candidate", 4))
        self.assertIn("novelty", d)
        self.assertIn("+2", d)

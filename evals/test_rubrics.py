import unittest
from evals.rubrics import RUBRICS, RUBRIC_VERSION


class RubricTests(unittest.TestCase):
    def test_four_stages_present(self) -> None:
        self.assertEqual(set(RUBRICS), {"extract", "directions", "repair", "prose"})

    def test_each_has_dimensions(self) -> None:
        for stage, r in RUBRICS.items():
            self.assertGreaterEqual(len(r["dimensions"]), 3, stage)
            for dim in r["dimensions"]:
                self.assertIn("key", dim)
                self.assertIn("desc", dim)

    def test_version_is_str(self) -> None:
        self.assertIsInstance(RUBRIC_VERSION, str)

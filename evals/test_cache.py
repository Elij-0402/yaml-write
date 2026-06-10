import tempfile
import unittest

from evals.cache import output_key, judge_key, Cache


class CacheTests(unittest.TestCase):
    def test_output_key_changes_with_prompt(self) -> None:
        k1 = output_key("extract", "PROMPT_A", "FIXHASH", "m", 0.7)
        k2 = output_key("extract", "PROMPT_B", "FIXHASH", "m", 0.7)
        self.assertNotEqual(k1, k2)

    def test_judge_key_changes_with_rubric_version(self) -> None:
        self.assertNotEqual(judge_key("v1", "m", "OUT"), judge_key("v2", "m", "OUT"))

    def test_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            c = Cache(d)
            self.assertIsNone(c.get("k1"))
            c.put("k1", {"a": 1})
            self.assertEqual(c.get("k1"), {"a": 1})

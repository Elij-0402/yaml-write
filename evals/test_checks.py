import unittest

from evals.checks import (
    check_dna_card, check_directions, check_prose, CheckResult,
)


class ChecksTests(unittest.TestCase):
    def test_good_dna_card_passes(self) -> None:
        card = {
            "structureSkeleton": [{"function": f"f{i}", "summary": f"s{i}"} for i in range(6)],
            "pacingSyuzhet": "节奏", "themeSkin": "题材", "proseStyle": "文笔",
        }
        r = check_dna_card(card)
        self.assertTrue(r.passed, r.failures)

    def test_too_few_beats_fails(self) -> None:
        card = {"structureSkeleton": [{"function": "f", "summary": "s"}],
                "pacingSyuzhet": "p", "themeSkin": "t", "proseStyle": "ps"}
        self.assertFalse(check_dna_card(card).passed)

    def test_directions_must_be_three(self) -> None:
        self.assertFalse(check_directions({"directions": []}).passed)

    def test_prose_slop_blacklist_hit(self) -> None:
        r = check_prose("仿佛整个世界都安静了。" * 30)
        self.assertFalse(r.passed)
        self.assertTrue(any("套路" in f or "黑名单" in f for f in r.failures))

    def test_prose_too_short(self) -> None:
        self.assertFalse(check_prose("太短").passed)

import unittest

from api.prompts import (
    build_book_direct_prompts,
    build_book_reduce_prompts,
    build_arc_map_prompts,
    FOUR_LAYER_DNA_GUIDE,
)
from api.schemas import BookDirectInput, BookReduceInput, ArcMapInput, ChapterMapItem


def _creds():
    return dict(apiKey="k", baseUrl="http://localhost:11434/v1", model="m", temperature=0.7)


class ExtractionPromptTests(unittest.TestCase):
    def test_direct_contains_guide_and_content(self) -> None:
        s, u = build_book_direct_prompts(
            BookDirectInput(novelName="书A", content="正文内容XYZ", **_creds())
        )
        self.assertIn(FOUR_LAYER_DNA_GUIDE, s)
        self.assertIn("正文内容XYZ", u)
        self.assertIn("书A", u)

    def test_reduce_builds_timeline(self) -> None:
        s, u = build_book_reduce_prompts(
            BookReduceInput(
                novelName="书B",
                mapSummaries=[ChapterMapItem(keyPlotTurns="转折K")],
                **_creds(),
            )
        )
        self.assertIn(FOUR_LAYER_DNA_GUIDE, s)
        self.assertIn("转折K", u)

    def test_arc_map_has_four_questions(self) -> None:
        s, u = build_arc_map_prompts(
            ArcMapInput(title="第1-5章", content="弧窗正文", **_creds())
        )
        self.assertIn("DNA 突变点", s)
        self.assertIn("弧窗正文", u)
        self.assertIn("第1-5章", u)

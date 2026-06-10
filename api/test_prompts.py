import unittest

from api.prompts import (
    build_book_direct_prompts,
    build_book_reduce_prompts,
    build_arc_map_prompts,
    FOUR_LAYER_DNA_GUIDE,
)
from api.schemas import BookDirectInput, BookReduceInput, ArcMapInput, ChapterMapItem
from api.prompts import build_fusion_directions_prompts, resolve_fusion_temperature
from api.schemas import (
    FusionDirectionsInput,
    EngineCardInput,
    StructureBeatItem,
    SkinSourceInput,
)


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


class FusionPromptTests(unittest.TestCase):
    def _engine(self):
        return EngineCardInput(
            novelName="骨架书",
            structureSkeleton=[StructureBeatItem(function="废柴受辱", summary="开局被欺")],
            pacingSyuzhet="先抑后扬",
        )

    def test_cross_branch_keeps_beats(self) -> None:
        s, u = build_fusion_directions_prompts(
            FusionDirectionsInput(engineCard=self._engine(),
                                  skinSource=SkinSourceInput(themeSkin="美食"),
                                  mode="cross", freedom=False, **_creds())
        )
        self.assertIn("换皮变题", s)
        self.assertIn("废柴受辱", u)

    def test_freedom_branch_differs(self) -> None:
        s, _ = build_fusion_directions_prompts(
            FusionDirectionsInput(engineCard=self._engine(), freedom=True, **_creds())
        )
        self.assertIn("灵感", s)

    def test_freedom_temperature_floor(self) -> None:
        d = FusionDirectionsInput(engineCard=self._engine(), freedom=True,
                                  apiKey="k", baseUrl="x", model="m", temperature=0.5)
        self.assertGreaterEqual(resolve_fusion_temperature(d), 0.9)
        d2 = FusionDirectionsInput(engineCard=self._engine(), freedom=False,
                                   apiKey="k", baseUrl="x", model="m", temperature=0.5)
        self.assertEqual(resolve_fusion_temperature(d2), 0.5)

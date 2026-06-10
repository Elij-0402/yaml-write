import unittest
from evals.stages import render_prompt, STAGE_SPECS


class StagesTests(unittest.TestCase):
    def test_specs_cover_four_stages(self) -> None:
        self.assertEqual(set(STAGE_SPECS), {"extract", "directions", "repair", "prose"})

    def test_render_prompt_extract(self) -> None:
        fixture = {"novelName": "书", "content": "正文ABC",
                   "apiKey": "", "baseUrl": "", "model": "m", "temperature": 0.7}
        system, user = render_prompt("extract", fixture)
        self.assertIn("正文ABC", user)

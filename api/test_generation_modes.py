import unittest

from api.index import (
    ANTI_SLOP_CONSTRAINT,
    NON_COLD_TONE_RELEASE,
    build_repair_prompts,
    build_tone_clause,
)
from api.schemas import RepairSettingGapsInput, StructureBeatItem


def _repair_input(**kw) -> RepairSettingGapsInput:
    base = dict(
        worldviewBlock="W", protagonistBlock="P", antagonistBlock="A", narrativeTone="N",
        structureSkeleton=[StructureBeatItem(function="废柴受辱", summary="开局被退婚")],
        themeSkin="深海高压",
        apiKey="sk-test", baseUrl="https://api.deepseek.com", model="deepseek-v4-flash",
    )
    base.update(kw)
    return RepairSettingGapsInput(**base)


class ToneClauseTests(unittest.TestCase):
    def test_empty_or_none_yields_no_clause(self):
        self.assertEqual(build_tone_clause(None), "")
        self.assertEqual(build_tone_clause(""), "")
        self.assertEqual(build_tone_clause("   "), "")

    def test_cold_has_register_but_no_release(self):
        clause = build_tone_clause("cold")
        self.assertIn("冷峻", clause)
        self.assertNotIn(NON_COLD_TONE_RELEASE, clause)

    def test_non_cold_appends_release(self):
        clause = build_tone_clause("hot")
        self.assertIn("热血", clause)
        self.assertIn(NON_COLD_TONE_RELEASE, clause)

    def test_unknown_tone_falls_back_with_release(self):
        clause = build_tone_clause("weird")
        self.assertIn("weird", clause)
        self.assertIn(NON_COLD_TONE_RELEASE, clause)


class RepairPromptTests(unittest.TestCase):
    def test_reskin_branch_enforces_source_structure(self):
        system, user = build_repair_prompts(_repair_input(freedom=False))
        self.assertIn("换皮迁移", system)
        self.assertIn("必须都被新题材支撑", user)
        self.assertIn(ANTI_SLOP_CONSTRAINT, system)

    def test_freedom_branch_does_not_pull_back_to_source(self):
        system, user = build_repair_prompts(_repair_input(freedom=True))
        self.assertIn("不要把设定拉回任何原书结构", system)
        self.assertIn("0→1 原创", system)
        self.assertNotIn("必须都被新题材支撑", user)
        self.assertIn("不要求逐一对应", user)
        self.assertIn(ANTI_SLOP_CONSTRAINT, system)

    def test_both_branches_include_all_four_setting_blocks(self):
        for freedom in (False, True):
            _, user = build_repair_prompts(_repair_input(freedom=freedom))
            for label in ("worldviewBlock", "protagonistBlock", "antagonistBlock", "narrativeTone"):
                self.assertIn(label, user)

    def test_adversarial_rules_injected_into_system(self):
        system, _ = build_repair_prompts(_repair_input(adversarialRules="禁止王子救公主"))
        self.assertIn("禁止王子救公主", system)


if __name__ == "__main__":
    unittest.main()

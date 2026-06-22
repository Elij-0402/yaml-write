import unittest
from api.schemas import (
    SceneEvaluateInput,
    SelectedDirection,
    StoryboardScene,
    ActiveCardItem,
    SceneEvaluateResponse,
    GateResult,
    SceneAuditResult,
)
from api.prompts import build_evaluator_system_prompt, build_evaluator_user_prompt, FORBIDDEN_STYLE_WORDS


class SceneEvaluatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.valid_input = SceneEvaluateInput(
            sceneId="scene_001",
            attempt=1,
            draft="这是一篇非常优秀的小说正文草稿，里面没有违禁词，情节紧凑。",
            selectedDirection=SelectedDirection(
                title="仙侠科幻融合",
                worldviewBlock="科学与修仙结合的世界",
                protagonistBlock="科学家主角萧炎",
                antagonistBlock="保守派魂天帝",
                narrativeTone="冷峻法医腔",
            ),
            currentScene=StoryboardScene(
                sceneNumber=1,
                sceneTitle="开端",
                plotOutline="主角在实验室里炼丹，遭到了魂天帝的窥视。",
                tensionLevel="mid",
                visualCues="深蓝色色调，培养皿中跳动着三色火苗",
            ),
            activeCards=[
                ActiveCardItem(
                    name="冷凝仪",
                    type="prop",
                    summary="科研道具",
                    details="能凝结灵气的仪器",
                    activeState="sceneActive",
                )
            ],
            apiKey="test-key",
            baseUrl="http://localhost:11434/v1",
            model="gpt-4",
            temperature=0.7,
        )

    def test_input_schema_validation(self) -> None:
        data = self.valid_input.model_dump()
        self.assertEqual(data["sceneId"], "scene_001")
        self.assertEqual(data["attempt"], 1)
        self.assertEqual(data["selectedDirection"]["title"], "仙侠科幻融合")
        self.assertEqual(data["currentScene"]["sceneTitle"], "开端")
        self.assertEqual(data["activeCards"][0]["name"], "冷凝仪")

    def test_output_schema_validation(self) -> None:
        response = SceneEvaluateResponse(
            sceneId="scene_001",
            attempt=1,
            passed=False,
            failedGates=["StyleLock"],
            evidence="【风格锁未通过】检测到违禁词/陈词滥调：嘴角上扬。",
            actionableFeedback="请修改嘴角上扬这一AI腔调。",
        )
        data = response.model_dump()
        self.assertEqual(data["sceneId"], "scene_001")
        self.assertEqual(data["passed"], False)
        self.assertEqual(data["failedGates"], ["StyleLock"])

    def test_prompt_builders(self) -> None:
        system_prompt = build_evaluator_system_prompt(self.valid_input)
        user_prompt = build_evaluator_user_prompt(self.valid_input)

        # 检查 System Prompt 中的核心审计锁关键字
        self.assertIn("风格锁", system_prompt)
        self.assertIn("人设锁", system_prompt)
        self.assertIn("大纲锁", system_prompt)
        self.assertIn("SceneAuditResult", system_prompt)

        # 检查 User Prompt 中的上下文细节
        self.assertIn("scene_001", user_prompt)
        self.assertIn("科学与修仙结合的世界", user_prompt)
        self.assertIn("科学家主角萧炎", user_prompt)
        self.assertIn("实验室里炼丹", user_prompt)
        self.assertIn("冷凝仪", user_prompt)
        self.assertIn("这是一篇非常优秀的小说正文草稿", user_prompt)

    def test_forbidden_words_logic(self) -> None:
        # 测试硬匹配违禁词拦截：使用真实的 FORBIDDEN_STYLE_WORDS 常量
        draft_with_slop = "这一刻，主角冷笑了一声，嘴角上扬，不可否认他的实力很强。"
        matched_words = [w for w in FORBIDDEN_STYLE_WORDS if w in draft_with_slop]
        self.assertIn("嘴角上扬", matched_words)
        self.assertIn("不可否认", matched_words)
        self.assertEqual(len(matched_words), 2)

        # 无违禁词的草稿不应命中
        clean_draft = "主角凝视远方，握紧了手中的剑。"
        clean_matched = [w for w in FORBIDDEN_STYLE_WORDS if w in clean_draft]
        self.assertEqual(len(clean_matched), 0)

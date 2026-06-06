import json
import unittest

from api.index import build_scene_user_prompt, classify_openai_error
from api.schemas import SceneTextInput, SelectedDirection, StoryboardScene


class SceneResumeSchemaTests(unittest.TestCase):
    def test_scene_text_input_contains_resume_fields(self) -> None:
        payload = SceneTextInput(
            selectedDirection=SelectedDirection(),
            currentScene=StoryboardScene(
                sceneNumber=1,
                sceneTitle='S1',
                plotOutline='plot',
                tensionLevel='mid',
                visualCues='rain',
            ),
            precedingTexts={1: 'prev'},
            currentDraft='draft text',
            resumeFromText='resume text',
            apiKey='k',
            baseUrl='http://localhost:11434/v1',
            model='m',
        )

        data = payload.model_dump()
        self.assertIn('currentDraft', data)
        self.assertIn('resumeFromText', data)
        self.assertEqual(data['currentDraft'], 'draft text')
        self.assertEqual(data['resumeFromText'], 'resume text')

    def test_build_scene_prompt_includes_resume_constraints(self) -> None:
        payload = SceneTextInput(
            selectedDirection=SelectedDirection(
                title='D',
                worldviewBlock='W',
                protagonistBlock='P',
                antagonistBlock='A',
                narrativeTone='N',
            ),
            currentScene=StoryboardScene(
                sceneNumber=2,
                sceneTitle='S2',
                plotOutline='plot',
                tensionLevel='high',
                visualCues='fog',
            ),
            precedingTexts={1: '前文'},
            currentDraft='已写内容',
            apiKey='k',
            baseUrl='http://localhost:11434/v1',
            model='m',
        )

        prompt = build_scene_user_prompt(payload)
        self.assertIn('当前分镜已生成正文（不要重复）', prompt)
        self.assertIn('严格从“当前分镜草稿”的最后一句继续接写', prompt)
        self.assertIn('已写内容', prompt)


class ClassifyOpenAIErrorTests(unittest.TestCase):
    """flash-500 修复回归：模型吐非法 JSON 必须归可重试的 422，未知异常仍是不可重试的 500。"""

    def test_json_decode_error_is_retryable_422(self) -> None:
        # cheap flash 在补洞偶发吐非法/截断 JSON 的核心场景；run_structured 的重试集含 422 才能救回
        status, code, _ = classify_openai_error(json.JSONDecodeError('Expecting value', '{bad', 0))
        self.assertEqual(status, 422)
        self.assertEqual(code, 'structured_parse_failed')

    def test_unknown_error_stays_non_retryable_500(self) -> None:
        # 兜底不被拓宽：真正未知异常仍归 500，避免静默重试掩盖真 bug
        status, code, _ = classify_openai_error(RuntimeError('boom'))
        self.assertEqual(status, 500)
        self.assertEqual(code, 'internal_error')

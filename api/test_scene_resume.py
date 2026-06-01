import unittest

from api.index import build_scene_user_prompt
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

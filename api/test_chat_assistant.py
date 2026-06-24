import unittest

from api.schemas import (
    ChatAssistantInput,
    ChatAssistantResponse,
    ChatMessage,
    EntityCardUpdate,
    VolumeItem,
    ChapterItem,
    SceneItem,
    VolumeUpdate,
    ChapterUpdate,
    SceneUpdate,
)
from api.prompts import build_chat_assistant_system_prompt, build_chat_assistant_user_prompt


class ChatAssistantSchemaTests(unittest.TestCase):
    def test_chat_assistant_input_accepts_valid_payload(self) -> None:
        payload = ChatAssistantInput(
            messages=[ChatMessage(role="user", content="把林鸣的性格改为冷酷")],
            novelId="novel-1",
            entityCards=[
                EntityCardUpdate(action="upsert", cardId="card-1", type="character", name="林鸣", summary="热情", details="")
            ],
            volumes=[],
            chapters=[],
            scenes=[],
            apiKey="sk-test",
            baseUrl="https://api.deepseek.com/v1",
            model="deepseek-chat",
            temperature=0.7,
        )
        data = payload.model_dump(by_alias=True)
        self.assertEqual(data["novelId"], "novel-1")
        self.assertEqual(len(data["messages"]), 1)
        self.assertEqual(data["messages"][0]["role"], "user")

    def test_chat_assistant_response_serializes_camel_case(self) -> None:
        resp = ChatAssistantResponse(
            reply="已修改",
            entityCardUpdates=[
                EntityCardUpdate(action="upsert", cardId="card-1", type="character", name="林鸣", summary="冷酷", details="")
            ],
            volumeUpdates=[],
            chapterUpdates=[],
            sceneUpdates=[],
        )
        data = resp.model_dump(by_alias=True)
        self.assertIn("entityCardUpdates", data)
        self.assertEqual(data["reply"], "已修改")
        self.assertEqual(len(data["entityCardUpdates"]), 1)
        self.assertEqual(data["entityCardUpdates"][0]["cardId"], "card-1")

    def test_build_chat_assistant_system_prompt_includes_context(self) -> None:
        cards = [
            EntityCardUpdate(action="upsert", cardId="card-1", type="character", name="林鸣", summary="热血少年", details="")
        ]
        volumes = [VolumeItem(id="vol-1", title="第一卷", order=1)]
        chapters = [ChapterItem(id="ch-1", volumeId="vol-1", title="第一章", order=1)]
        scenes = []
        prompt = build_chat_assistant_system_prompt(cards, volumes, chapters, scenes)
        self.assertIn("林鸣", prompt)
        self.assertIn("card-1", prompt)
        self.assertIn("第一卷", prompt)
        self.assertIn("第一章", prompt)
        self.assertIn("cardId", prompt)

    def test_build_chat_assistant_system_prompt_empty_context(self) -> None:
        prompt = build_chat_assistant_system_prompt([], [], [], [])
        self.assertIn("暂无设定卡片", prompt)
        self.assertIn("暂无大纲", prompt)

    def test_build_chat_assistant_user_prompt_includes_history(self) -> None:
        # review #2：端点须把完整多轮历史拼进 prompt（而非只取最后一条 user）。
        messages = [
            ChatMessage(role="user", content="把林鸣改成冷酷"),
            ChatMessage(role="assistant", content="已修改"),
            ChatMessage(role="user", content="再加一个道具卡"),
        ]
        prompt = build_chat_assistant_user_prompt(messages)
        self.assertIn("把林鸣改成冷酷", prompt)   # 历史 user
        self.assertIn("已修改", prompt)            # 历史 assistant
        self.assertIn("再加一个道具卡", prompt)    # 当前指令
        self.assertIn("当前用户指令", prompt)
        self.assertIn("对话历史", prompt)

    def test_build_chat_assistant_user_prompt_single_turn_no_history(self) -> None:
        prompt = build_chat_assistant_user_prompt([ChatMessage(role="user", content="你好")])
        self.assertIn("你好", prompt)
        self.assertNotIn("对话历史", prompt)


if __name__ == "__main__":
    unittest.main()

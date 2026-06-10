import json
import unittest

from evals.judge import build_judge_messages, parse_judge_json, judge_output, JudgeScore


class JudgeParseTests(unittest.TestCase):
    def test_build_messages_includes_rubric_dims(self) -> None:
        msgs = build_judge_messages("extract", produced={"pacingSyuzhet": "x"}, reference=None)
        joined = json.dumps(msgs, ensure_ascii=False)
        self.assertIn("structure_accuracy", joined)
        self.assertIn("0=", joined)  # 评分锚点

    def test_parse_valid_json(self) -> None:
        raw = '{"scores":[{"dimension":"craft","score":3,"reason":"好"}],"overall":"还行"}'
        parsed = parse_judge_json(raw)
        self.assertEqual(parsed[0].dimension, "craft")
        self.assertEqual(parsed[0].score, 3)

    def test_parse_strips_codefence(self) -> None:
        raw = '```json\n{"scores":[{"dimension":"craft","score":4,"reason":"r"}]}\n```'
        parsed = parse_judge_json(raw)
        self.assertEqual(parsed[0].score, 4)

    def test_judge_output_with_fake_client(self) -> None:
        class FakeResp:
            def __init__(self, content):
                self.choices = [type("C", (), {"message": type("M", (), {"content": content})()})()]

        class FakeClient:
            def __init__(self, content):
                self._c = content
                self.chat = type("Chat", (), {"completions": self})()

            def create(self, **kw):
                return FakeResp(self._c)

        client = FakeClient('{"scores":[{"dimension":"novelty","score":2,"reason":"一般"}],"overall":"o"}')
        scores = judge_output("directions", produced={"directions": []}, reference=None,
                              client=client, model="deepseek-chat", temperature=0.0)
        self.assertEqual(scores[0].score, 2)

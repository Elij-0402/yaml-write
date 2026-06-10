import os
import unittest

from evals.config import load_config, EvalConfig


class ConfigTests(unittest.TestCase):
    def test_reads_api_key_from_env(self) -> None:
        os.environ["DEEPSEEK_API_KEY"] = "sk-test"
        cfg = load_config()
        self.assertEqual(cfg.api_key, "sk-test")
        self.assertIn("deepseek", cfg.base_url)
        self.assertEqual(cfg.judge_model, "deepseek-chat")

    def test_missing_key_raises(self) -> None:
        os.environ.pop("DEEPSEEK_API_KEY", None)
        with self.assertRaises(RuntimeError):
            load_config()

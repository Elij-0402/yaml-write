import json
import os
import tempfile
import unittest

from api.index import capture_fixture


class CaptureTests(unittest.TestCase):
    def test_disabled_by_default(self) -> None:
        os.environ.pop("EVAL_CAPTURE", None)
        with tempfile.TemporaryDirectory() as d:
            capture_fixture("extract-book-direct", {"content": "x", "apiKey": "sk-secret"}, base_dir=d)
            self.assertEqual(os.listdir(d), [])

    def test_writes_scrubbed_when_enabled(self) -> None:
        os.environ["EVAL_CAPTURE"] = "1"
        with tempfile.TemporaryDirectory() as d:
            capture_fixture(
                "extract-book-direct",
                {"content": "x", "apiKey": "sk-secret", "baseUrl": "u"},
                base_dir=d,
            )
            files = os.listdir(d)
            self.assertEqual(len(files), 1)
            blob = json.loads(open(os.path.join(d, files[0]), encoding="utf-8").read())
            self.assertNotIn("sk-secret", json.dumps(blob))
            self.assertEqual(blob.get("apiKey", ""), "")
        os.environ.pop("EVAL_CAPTURE", None)

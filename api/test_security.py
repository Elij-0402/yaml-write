import unittest

import httpx
from pydantic import ValidationError
from openai import AuthenticationError, BadRequestError, RateLimitError

from api.index import (
    ApiError,
    classify_openai_error,
    mask_api_key,
    normalize_base_url,
    scrub_sensitive,
    validate_base_url,
)
from api.schemas import StructureBeat


class NormalizeBaseUrlTests(unittest.TestCase):
    """SSRF 第一道：URL 规范化与协议/认证信息约束。"""

    def test_keeps_whitelisted_url_intact(self):
        self.assertEqual(normalize_base_url('https://api.openai.com/v1'), 'https://api.openai.com/v1')

    def test_appends_default_v1_when_path_missing(self):
        self.assertEqual(normalize_base_url('https://api.openai.com'), 'https://api.openai.com/v1')

    def test_rejects_missing_scheme(self):
        with self.assertRaises(ApiError):
            normalize_base_url('api.openai.com/v1')

    def test_rejects_embedded_credentials_or_query(self):
        with self.assertRaises(ApiError):
            normalize_base_url('https://user:pass@api.openai.com/v1')
        with self.assertRaises(ApiError):
            normalize_base_url('https://api.openai.com/v1?token=x')

    def test_rejects_http_for_non_local_host(self):
        with self.assertRaises(ApiError):
            normalize_base_url('http://api.openai.com/v1')

    def test_allows_http_only_for_localhost(self):
        self.assertEqual(normalize_base_url('http://localhost:11434/v1'), 'http://localhost:11434/v1')


class ValidateBaseUrlTests(unittest.TestCase):
    """SSRF 第二道：白名单 + 私网/本地端口阻断。"""

    def test_allows_default_cloud_whitelist(self):
        self.assertEqual(validate_base_url('https://api.openai.com/v1'), 'https://api.openai.com/v1')

    def test_allows_localhost_ollama_port(self):
        self.assertEqual(validate_base_url('http://localhost:11434/v1'), 'http://localhost:11434/v1')

    def test_rejects_unlisted_host(self):
        with self.assertRaises(ApiError):
            validate_base_url('https://evil.example.com/v1')

    def test_rejects_private_network_ip(self):
        with self.assertRaises(ApiError):
            validate_base_url('https://10.0.0.1/v1')

    def test_rejects_local_non_whitelisted_port(self):
        with self.assertRaises(ApiError):
            validate_base_url('http://localhost:8080/v1')


class ScrubAndMaskTests(unittest.TestCase):
    """日志脱敏防线：明文 key 不得外泄。"""

    def test_mask_api_key_keeps_only_prefix_and_last4(self):
        self.assertEqual(mask_api_key('sk-abcdefghij'), 'sk-***ghij')

    def test_mask_short_key_is_fully_hidden(self):
        self.assertEqual(mask_api_key('short'), '***')

    def test_scrub_hides_api_key_value_in_text(self):
        scrubbed = scrub_sensitive('config {"api_key": "sk-secret123456"}')
        self.assertNotIn('sk-secret123456', scrubbed)
        self.assertIn('sk-***', scrubbed)


class ClassifyOpenAIErrorBranchTests(unittest.TestCase):
    """补全 classify_openai_error 分支（既有 test_scene_resume 仅覆盖 JSONDecodeError / unknown）。"""

    @staticmethod
    def _openai_exc(exc_cls, status, message='err'):
        request = httpx.Request('POST', 'https://api.example.com/v1/chat/completions')
        response = httpx.Response(status, request=request)
        return exc_cls(message, response=response, body=None)

    def test_authentication_error_maps_to_401(self):
        status, code, _ = classify_openai_error(self._openai_exc(AuthenticationError, 401))
        self.assertEqual((status, code), (401, 'auth_error'))

    def test_rate_limit_error_maps_to_429(self):
        status, code, _ = classify_openai_error(self._openai_exc(RateLimitError, 429))
        self.assertEqual((status, code), (429, 'rate_limited'))

    def test_bad_request_with_tool_hint_suggests_structured_model(self):
        exc = self._openai_exc(BadRequestError, 400, 'this model does not support tools')
        status, code, msg = classify_openai_error(exc)
        self.assertEqual((status, code), (400, 'bad_request'))
        self.assertIn('结构化', msg)

    def test_pydantic_validation_error_is_retryable_422(self):
        try:
            StructureBeat()  # 缺必填 function/summary → ValidationError
            self.fail('expected ValidationError')
        except ValidationError as exc:
            status, code, _ = classify_openai_error(exc)
            self.assertEqual((status, code), (422, 'structured_parse_failed'))


if __name__ == '__main__':
    unittest.main()

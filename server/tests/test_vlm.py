"""The VLM path: prompt construction, response parsing, and fallback behaviour.

No network. The point of these tests is that a small open-weights model's messier
output still produces a valid action, and that anything it gets wrong degrades to
the deterministic planner rather than to an exception.
"""

from __future__ import annotations

import pytest

from app.prompt import SYSTEM_PROMPT, build_user_message
from app.schemas import StepRequest
from app.vlm import VLMError, parse_action

from .fixtures import FAKE, sanitized_request


class TestSystemPrompt:
    def test_explains_the_redaction_scheme(self):
        # The problem statement requires the server to be aware of the scheme.
        for phrase in ["⟦TYPE_N⟧", "⟦PROFILE.KEY⟧", "never guess", "element_id"]:
            assert phrase.lower() in SYSTEM_PROMPT.lower()

    def test_forbids_irreversible_clicks(self):
        assert "irreversible" in SYSTEM_PROMPT.lower()
        assert "ask_user" in SYSTEM_PROMPT

    def test_forbids_typing_passwords(self):
        assert "never attempt to type a password" in SYSTEM_PROMPT.lower()


class TestUserMessage:
    def test_includes_the_task_elements_and_redactions(self):
        message = build_user_message(StepRequest(**sanitized_request()))
        assert "stop before submitting" in message
        assert "Full name" in message
        assert "⟦AADHAAR_1⟧" in message
        assert "FULL_NAME" in message

    def test_contains_no_raw_pii(self):
        message = build_user_message(StepRequest(**sanitized_request()))
        assert FAKE["email"] not in message
        assert FAKE["aadhaar"] not in message

    def test_explains_a_missing_screenshot(self):
        payload = sanitized_request(disclosure_level=1)
        payload.pop("screen", None)
        message = build_user_message(StepRequest(**payload))
        assert "no screenshot this step" in message

    def test_truncates_a_long_history(self):
        payload = sanitized_request()
        payload["history"] = [{"action": "scroll", "ok": True} for _ in range(40)]
        message = build_user_message(StepRequest(**payload))
        assert message.count('"action": "scroll"') <= 8


class TestParseAction:
    def test_parses_clean_json(self):
        assert parse_action('{"action": "click", "element_id": 3}')["element_id"] == 3

    def test_parses_a_markdown_fence(self):
        raw = 'Here is my decision:\n```json\n{"action": "done", "summary": "all set"}\n```'
        assert parse_action(raw)["action"] == "done"

    def test_parses_an_unfenced_object_inside_prose(self):
        raw = 'I will fill the email field. {"action": "type", "element_id": 2} Done.'
        assert parse_action(raw)["element_id"] == 2

    def test_handles_nested_braces(self):
        raw = 'Result: {"action": "type", "element_id": 2, "meta": {"a": {"b": 1}}}'
        assert parse_action(raw)["meta"]["a"]["b"] == 1

    def test_raises_when_there_is_no_json(self):
        with pytest.raises(VLMError):
            parse_action("I am not sure what to do here.")

    def test_raises_on_an_unbalanced_object(self):
        with pytest.raises(VLMError):
            parse_action('{"action": "click", ')


class TestFallback:
    async def test_unconfigured_endpoint_raises_so_the_caller_falls_back(self):
        from app.vlm import VLMConfig, decide

        config = VLMConfig(base_url="", model="", api_key="", timeout=1)
        with pytest.raises(VLMError):
            await decide(StepRequest(**sanitized_request()), config)

    async def test_an_unreachable_endpoint_raises_rather_than_hanging(self):
        from app.vlm import VLMConfig, decide

        # Reserved-for-documentation address: connection fails fast, no DNS lookup.
        config = VLMConfig(
            base_url="http://192.0.2.1:9/v1", model="test", api_key="", timeout=0.5
        )
        with pytest.raises(VLMError):
            await decide(StepRequest(**sanitized_request()), config)

"""The VLM path: prompt construction, response parsing, and fallback behaviour.

No network. The point of these tests is that a small open-weights model's messier
output still produces a valid action, and that anything it gets wrong degrades to
the deterministic planner rather than to an exception.
"""

from __future__ import annotations

import pytest

from app.prompt import SYSTEM_PROMPT, build_user_message
from app.schemas import StepRequest
from app.vlm import VLMError, answer_text, parse_action

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

    def test_carries_the_screen_text_as_plain_lines(self):
        payload = sanitized_request(visible_text='Status: "Approved"\nContact ⟦EMAIL_1⟧')
        message = build_user_message(StepRequest(**payload))
        assert 'SCREEN TEXT' in message
        assert 'Status: "Approved"\nContact ⟦EMAIL_1⟧' in message  # not JSON-escaped

    def test_says_when_the_page_goes_on(self):
        payload = sanitized_request()
        payload["page"] = {**payload["page"], "more_below": True}
        assert "continues below" in build_user_message(StepRequest(**payload))
        assert "continues below" not in build_user_message(StepRequest(**sanitized_request()))

    def test_tells_the_model_to_answer_questions_verbatim(self):
        assert "exactly as the" in SYSTEM_PROMPT and "SCREEN TEXT" in SYSTEM_PROMPT


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



class TestAnswerText:
    """Reasoning models hide the answer three different ways; all three are handled."""

    def test_strips_inline_reasoning(self):
        msg = {"content": '<think>field 1 is empty</think>{"action": "done", "summary": "x"}'}
        assert answer_text(msg) == '{"action": "done", "summary": "x"}'

    def test_drops_an_unterminated_think_when_the_budget_ran_out(self):
        assert answer_text({"content": "<think>still reasoning when the tokens ran out"}) == ""

    def test_falls_back_to_a_separate_reasoning_field(self):
        msg = {"content": "", "reasoning_content": 'so: {"action": "done", "summary": "x"}'}
        assert parse_action(answer_text(msg))["action"] == "done"

    def test_reads_content_parts(self):
        msg = {"content": [{"type": "text", "text": '{"action": "done", "summary": "x"}'}]}
        assert parse_action(answer_text(msg))["action"] == "done"

    def test_empty_stays_empty(self):
        assert answer_text({"content": None}) == ""

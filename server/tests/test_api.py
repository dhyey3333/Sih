"""End-to-end API behaviour, with no VLM configured.

Every test here runs offline. That is the point of the deterministic planner: the
full request → guard → decide → respond path is exercised with no key and no network.
"""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app

from .fixtures import FAKE, sanitized_request


@pytest.fixture
def client(monkeypatch):
    # Make sure a developer's real .env cannot turn these into live model calls.
    monkeypatch.delenv("VLM_BASE_URL", raising=False)
    monkeypatch.delenv("VLM_MODEL", raising=False)
    with TestClient(app) as c:
        yield c


class TestHealth:
    def test_reports_which_planner_is_live(self, client):
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["vlm_configured"] is False
        assert body["planner"] == "rule-based"


class TestHappyPath:
    def test_accepts_a_sanitized_payload(self, client):
        response = client.post("/v1/step", json=sanitized_request())
        assert response.status_code == 200

    def test_fills_the_first_field_it_holds_a_profile_value_for(self, client):
        body = client.post("/v1/step", json=sanitized_request()).json()
        assert body["action"] == "type"
        assert body["element_id"] == 1
        assert body["text"] == "⟦PROFILE.FULL_NAME⟧"

    def test_returns_a_token_never_a_value(self, client):
        body = client.post("/v1/step", json=sanitized_request()).json()
        assert body["text"].startswith("⟦")
        assert FAKE["full_name"] not in response_text(body)

    def test_reports_timings_for_the_latency_breakdown(self, client):
        body = client.post("/v1/step", json=sanitized_request()).json()
        assert "guard" in body["timings"]
        assert "inference" in body["timings"]
        assert body["timings"]["server_total"] >= 0

    def test_says_which_planner_decided(self, client):
        body = client.post("/v1/step", json=sanitized_request()).json()
        assert body["planner"] == "rule-based"


class TestPasswordHandling:
    def test_never_tries_to_type_a_password(self, client):
        payload = sanitized_request(profile_keys=[])
        # Only the password field is left fillable.
        payload["elements"] = [e for e in payload["elements"] if e["id"] in (3, 5)]
        body = client.post("/v1/step", json=payload).json()
        assert body["action"] != "type"


class TestIrreversibleActions:
    def test_asks_before_pressing_submit(self, client):
        payload = sanitized_request(task="Fill and submit this form")
        for element in payload["elements"]:
            if element.get("sensitive") and element["sensitive"] != "PASSWORD":
                element["filled"] = True
                element["value"] = "⟦PROFILE.EMAIL⟧"
        body = client.post("/v1/step", json=payload).json()
        assert body["action"] == "ask_user"
        assert body["element_id"] == 5

    def test_stops_before_submit_when_the_task_says_to(self, client):
        payload = sanitized_request()  # task says "stop before submitting"
        for element in payload["elements"]:
            if element.get("sensitive") and element["sensitive"] != "PASSWORD":
                element["filled"] = True
                element["value"] = "⟦PROFILE.EMAIL⟧"
        body = client.post("/v1/step", json=payload).json()
        assert body["action"] == "done"
        assert "stopping before submit" in body["summary"]


class TestLoopProtection:
    def test_gives_up_on_an_element_that_failed_twice(self, client):
        payload = sanitized_request()
        payload["history"] = [
            {"action": "type", "element_id": 1, "ok": False, "error": "not editable"},
            {"action": "type", "element_id": 1, "ok": False, "error": "not editable"},
        ]
        body = client.post("/v1/step", json=payload).json()
        assert body.get("element_id") != 1

    def test_does_not_refill_a_field_it_already_typed(self, client):
        payload = sanitized_request()
        payload["history"] = [{"action": "type", "element_id": 1, "ok": True}]
        body = client.post("/v1/step", json=payload).json()
        assert body.get("element_id") != 1


class TestInboundGuard:
    @pytest.mark.parametrize(
        "value,expected_type",
        [
            (FAKE["email"], "EMAIL"),
            (FAKE["phone"], "PHONE"),
            (FAKE["aadhaar_spaced"], "AADHAAR"),
            (FAKE["card"], "CARD"),
            (FAKE["pan"], "PAN"),
        ],
    )
    def test_rejects_raw_pii_in_a_label(self, client, value, expected_type):
        payload = sanitized_request()
        payload["elements"][1]["label"] = f"Email ({value})"
        response = client.post("/v1/step", json=payload)
        assert response.status_code == 422
        assert expected_type in [i["type"] for i in response.json()["incidents"]]

    def test_rejects_raw_pii_in_a_value(self, client):
        payload = sanitized_request()
        payload["elements"][1]["value"] = FAKE["email"]
        response = client.post("/v1/step", json=payload)
        assert response.status_code == 422
        assert response.json()["incidents"][0]["path"].endswith("value")

    def test_rejects_raw_pii_in_an_earlier_turn(self, client):
        # The conversation is a wire field like any other: a client bug that left a
        # value in a previous task is refused, not forwarded to the model.
        payload = sanitized_request(conversation=[{"task": f"my email is {FAKE['email']}", "summary": "Noted."}])
        response = client.post("/v1/step", json=payload)
        assert response.status_code == 422
        assert "conversation" in response.json()["incidents"][0]["path"]

    def test_accepts_a_tokenized_conversation(self, client):
        payload = sanitized_request(conversation=[{"task": "Fill this form", "summary": "Filled ⟦PROFILE.EMAIL⟧."}])
        assert client.post("/v1/step", json=payload).status_code == 200

    def test_rejects_raw_pii_in_the_task_or_title(self, client):
        payload = sanitized_request(task=f"email {FAKE['email']} for me")
        assert client.post("/v1/step", json=payload).status_code == 422

        payload = sanitized_request()
        payload["page"]["title"] = f"Profile of {FAKE['email']}"
        assert client.post("/v1/step", json=payload).status_code == 422

    def test_rejects_raw_pii_in_the_screen_text(self, client):
        payload = sanitized_request(visible_text=f"Status: Approved\nAadhaar {FAKE['aadhaar_spaced']}")
        response = client.post("/v1/step", json=payload)
        assert response.status_code == 422
        assert response.json()["incidents"][0]["path"] == "visible_text"

    def test_the_rejection_never_echoes_the_value(self, client):
        payload = sanitized_request()
        payload["elements"][1]["label"] = f"Email ({FAKE['email']})"
        body = client.post("/v1/step", json=payload).text
        assert FAKE["email"] not in body
        assert "ananya" not in body.lower()

    def test_does_not_scan_the_screenshot_as_text(self, client):
        payload = sanitized_request()
        # A megabyte of digits contains Luhn-valid runs by chance.
        payload["screen"] = {"image_jpeg_b64": "9" * 50_000, "width": 1280, "height": 800}
        assert client.post("/v1/step", json=payload).status_code == 200

    def test_tokens_are_not_mistaken_for_pii(self, client):
        payload = sanitized_request()
        payload["elements"][1]["value"] = "⟦PROFILE.EMAIL⟧"
        assert client.post("/v1/step", json=payload).status_code == 200


class TestSchemaValidation:
    def test_rejects_a_malformed_payload(self, client):
        assert client.post("/v1/step", json={"nope": True}).status_code == 422

    def test_rejects_an_out_of_range_disclosure_level(self, client):
        assert client.post("/v1/step", json=sanitized_request(disclosure_level=9)).status_code == 422

    def test_accepts_structure_only_with_no_screenshot(self, client):
        payload = sanitized_request(disclosure_level=1)
        payload.pop("screen", None)
        assert client.post("/v1/step", json=payload).status_code == 200


def response_text(body: dict) -> str:
    return copy.deepcopy(body).__str__()


class TestReadOnlyTasks:
    """A question must be answered, not acted on.

    "Describe what is on this page" used to fall through to the form-filling path
    and reply "Filled every field I could" — an answer to a different question, and
    an action nobody asked for.
    """

    def test_a_describe_task_is_answered_not_filled(self, client):
        body = client.post(
            "/v1/step", json=sanitized_request(task="Describe what is on this page")
        ).json()
        assert body["action"] == "done"
        assert "Filled every field" not in body["summary"]

    def test_the_answer_is_about_the_actual_screen(self, client):
        body = client.post(
            "/v1/step", json=sanitized_request(task="Describe what is on this page")
        ).json()
        summary = body["summary"]
        assert "demo.local/apply" in summary
        # The fixture has 4 inputs, 1 button and one AADHAAR redaction.
        assert "button" in summary
        assert "AADHAAR" in summary
        assert "cannot see" in summary

    def test_it_says_so_when_nothing_was_redacted(self, client):
        body = client.post(
            "/v1/step",
            json=sanitized_request(task="Summarise this page", redactions=[]),
        ).json()
        assert "needed redacting" in body["summary"]

    def test_a_fill_task_still_fills(self, client):
        """The read-only check must not swallow ordinary instructions."""
        body = client.post(
            "/v1/step", json=sanitized_request(task="Fill this form with my profile")
        ).json()
        assert body["action"] == "type"

    def test_a_page_with_no_controls_is_described_honestly(self, client):
        body = client.post(
            "/v1/step", json=sanitized_request(task="What is on this page?", elements=[])
        ).json()
        assert body["action"] == "done"
        assert "No form controls" in body["summary"]

    def test_the_summary_agrees_with_itself_grammatically(self, client):
        """It is read aloud in a demo; "4 fields asks" is not acceptable there."""
        body = client.post(
            "/v1/step", json=sanitized_request(task="Describe what is on this page")
        ).json()
        summary = body["summary"]
        assert "fields asks" not in summary and "field ask " not in summary
        assert "regions was" not in summary and "region were" not in summary


class TestTheDoor:
    def test_an_extension_origin_may_call(self, client):
        r = client.options("/v1/step", headers={"Origin": "chrome-extension://abcdefghijklmnop",
                                                 "Access-Control-Request-Method": "POST"})
        assert r.headers.get("access-control-allow-origin") == "chrome-extension://abcdefghijklmnop"

    def test_a_web_page_may_not(self, client):
        r = client.options("/v1/step", headers={"Origin": "https://evil.example",
                                                 "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in r.headers

    def test_a_token_is_required_once_set(self, client, monkeypatch):
        monkeypatch.setattr(main, "PLANNER_TOKEN", "s3cret-for-tests")
        assert client.post("/v1/step", json=sanitized_request()).status_code == 401
        wrong = {"Authorization": "Bearer nope"}
        assert client.post("/v1/step", json=sanitized_request(), headers=wrong).status_code == 401
        right = {"Authorization": "Bearer s3cret-for-tests"}
        assert client.post("/v1/step", json=sanitized_request(), headers=right).status_code == 200
        assert client.get("/health").json()["auth_required"] is True

    def test_refuses_something_too_big_to_be_a_step(self, client, monkeypatch):
        monkeypatch.setattr(main, "MAX_BODY_BYTES", 1000)
        assert client.post("/v1/step", json=sanitized_request(task="x" * 2000)).status_code == 413

    def test_slows_a_runaway_loop(self, client, monkeypatch):
        monkeypatch.setattr(main, "RATE_BURST", 3.0)
        monkeypatch.setattr(main, "RATE_PER_SECOND", 0.001)
        codes = [client.post("/v1/step", json=sanitized_request()).status_code for _ in range(5)]
        assert codes[:3] == [200, 200, 200] and codes[3:] == [429, 429]

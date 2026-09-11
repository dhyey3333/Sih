"""The VLM path over a real socket.

Everything else in this suite mocks the model out. This file does not: it starts
`tools/mock_vlm.py` on a real port, points the server's `VLM_BASE_URL` at it, and
drives `/v1/step` through the actual `httpx` client. The prompt is really built,
really serialized, really posted, and the reply is really parsed and validated.

What that buys, given the endpoint is not a model (see `tools/mock_vlm.py`):

  * the request we send is one an OpenAI-compatible server accepts — wrong shapes
    fail here, not in front of a judge;
  * `build_user_message` carries enough for a caller to act on, because the stub
    decides from that text alone;
  * a reply wrapped in prose and a markdown fence, which is what small open-weights
    models actually emit, survives `parse_action`;
  * `planner` comes back as `"vlm"`, so the fallback did *not* quietly cover for a
    broken path — the usual way this kind of test passes for the wrong reason.
"""

from __future__ import annotations

import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from tools.mock_vlm import app as mock_app

from .fixtures import sanitized_request


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class _Server(uvicorn.Server):
    """A uvicorn server that can be started and stopped from the test thread."""

    def install_signal_handlers(self) -> None:  # pragma: no cover - not a real process
        pass


@pytest.fixture(scope="module")
def vlm_url() -> str:
    port = _free_port()
    server = _Server(uvicorn.Config(mock_app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}/v1"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            if httpx.get(f"{base}/models", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.05)
    else:  # pragma: no cover - only on a very slow machine
        pytest.fail("the mock VLM did not come up")

    yield base

    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def client(vlm_url: str, monkeypatch: pytest.MonkeyPatch):
    """The real server, configured to talk to the real socket above."""
    monkeypatch.setenv("VLM_BASE_URL", vlm_url)
    monkeypatch.setenv("VLM_MODEL", "mock-vl")
    monkeypatch.setenv("VLM_API_KEY", "not-a-secret")

    # Imported here so the env vars are set before the module-level config is read;
    # the lifespan handler reloads it when TestClient enters the context anyway.
    from app.main import app as real_app

    with TestClient(real_app) as test_client:
        yield test_client


class TestLiveRoundTrip:
    def test_health_reports_the_configured_model(self, client: TestClient):
        body = client.get("/health").json()
        assert body["planner"] == "vlm"
        assert body["vlm_model"] == "mock-vl"

    def test_a_step_is_decided_over_the_wire(self, client: TestClient):
        response = client.post("/v1/step", json=sanitized_request())
        assert response.status_code == 200

        body = response.json()
        # The whole point: this came back from the socket, not from the fallback.
        assert body["planner"] == "vlm"
        assert body["action"] == "type"
        assert body["element_id"] == 1
        assert body["text"] == "⟦PROFILE.FULL_NAME⟧"

    def test_it_returns_a_token_and_never_a_value(self, client: TestClient):
        body = client.post("/v1/step", json=sanitized_request()).json()
        assert body["text"].startswith("⟦PROFILE.")
        assert "Ananya" not in response_text(body)

    def test_it_will_not_type_into_a_password_field(self, client: TestClient):
        """Field 3 is the password. It has no token, so no step may target it."""
        seen = set()
        payload = sanitized_request()
        for _ in range(4):
            body = client.post("/v1/step", json=payload).json()
            if body["action"] != "type":
                break
            seen.add(body["element_id"])
            payload["history"] = payload["history"] + [
                {"action": "type", "element_id": body["element_id"], "ok": True}
            ]
        assert 3 not in seen

    def test_it_asks_rather_than_pressing_submit(self, client: TestClient):
        """Once the fields are done, the only control left is irreversible."""
        payload = sanitized_request(
            elements=[
                {"id": 1, "role": "textbox", "bbox": [10, 20, 200, 32], "label": "Full name", "filled": True, "value": "⟦PROFILE.FULL_NAME⟧"},
                {"id": 5, "role": "button", "bbox": [10, 400, 160, 40], "text": "Submit application"},
            ]
        )
        body = client.post("/v1/step", json=payload).json()
        assert body["action"] == "ask_user"
        assert body["planner"] == "vlm"

    def test_it_falls_back_when_the_endpoint_disappears(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ):
        """A dead VLM must degrade to the deterministic planner, not to a 500."""
        from app import main

        monkeypatch.setattr(
            main, "_config", main.load_config().__class__(
                base_url="http://127.0.0.1:1",  # nothing listens here
                model="mock-vl",
                api_key="",
                timeout=0.4,
            )
        )
        body = client.post("/v1/step", json=sanitized_request()).json()
        assert body["planner"] == "rule-based"
        assert body["action"] in {"type", "click", "ask_user", "done"}
        assert "VLM unavailable" in body["reason"]


def response_text(body: dict) -> str:
    """Every string the server sent back, for a "no raw value" assertion."""
    return " ".join(str(value) for value in body.values())

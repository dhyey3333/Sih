"""The live "what the server sees" page: off by default, and never more than it received."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import view
from app.main import app

from .fixtures import FAKE, sanitized_request


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("VLM_BASE_URL", raising=False)
    monkeypatch.delenv("VLM_MODEL", raising=False)
    view._recent.clear()
    with TestClient(app) as c:
        yield c


def test_is_off_unless_asked_for(client, monkeypatch):
    monkeypatch.setattr(view, "ENABLED", False)
    assert client.get("/view").status_code == 404
    assert client.get("/view/recent").status_code == 404
    client.post("/v1/step", json=sanitized_request())
    assert len(view._recent) == 0  # nothing is kept when it is off


def test_shows_each_step_as_received(client, monkeypatch):
    monkeypatch.setattr(view, "ENABLED", True)
    assert "What the server sees" in client.get("/view").text
    client.post("/v1/step", json=sanitized_request(visible_text="Status: Approved"))
    [item] = client.get("/view/recent").json()
    assert item["kind"] == "step" and item["screen_text"] == "Status: Approved"
    assert item["action"]["action"] in {"type", "ask_user", "done"}
    assert "⟦AADHAAR_1⟧" in [r["token"] for r in item["redactions"]]


def test_a_rejected_payload_shows_as_its_incident_and_nothing_else(client, monkeypatch):
    monkeypatch.setattr(view, "ENABLED", True)
    client.post("/v1/step", json=sanitized_request(task=f"email {FAKE['email']} for me"))
    [item] = client.get("/view/recent").json()
    assert item["kind"] == "rejected" and item["incidents"]
    assert FAKE["email"] not in str(item)  # the offending payload itself is never kept


def test_keeps_only_the_last_few(client, monkeypatch):
    monkeypatch.setattr(view, "ENABLED", True)
    for _ in range(view.KEEP + 5):
        client.post("/v1/step", json=sanitized_request())
    assert len(client.get("/view/recent").json()) == view.KEEP

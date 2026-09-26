"""Shared test setup."""

from __future__ import annotations

import pytest

from app import main


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    """The rate limit is per process, and the whole suite is one client address."""
    main._buckets.clear()
    yield


@pytest.fixture(autouse=True)
def _no_token_from_a_developers_env(monkeypatch):
    """A PLANNER_TOKEN in someone's server/.env must not turn every test into a 401."""
    monkeypatch.setattr(main, "PLANNER_TOKEN", "")

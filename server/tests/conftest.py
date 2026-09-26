"""Shared test setup."""

from __future__ import annotations

import pytest

from app import main


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    """The rate limit is per process, and the whole suite is one client address."""
    main._buckets.clear()
    yield

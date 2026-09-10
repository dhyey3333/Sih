"""Test fixtures. FAKE DATA ONLY — mirrors extension/tests/fixtures.ts."""

from __future__ import annotations

from typing import Any

FAKE = {
    "email": "ananya.iyer@example.com",
    "phone": "9812345678",
    "aadhaar": "223456789018",  # Verhoeff-valid
    "aadhaar_spaced": "2234 5678 9018",
    "aadhaar_bad": "223456789012",
    "card": "4111111111111111",  # Luhn-valid Visa test number
    "card_bad": "4111111111111112",
    "pan": "ABCPI1234K",
    "pan_bad": "ABCXI1234K",  # X is not a valid holder type
    "ifsc": "HDFC0001234",
    "upi": "ananya@okhdfcbank",
    "full_name": "Ananya Iyer",
}

NOT_PII = [
    "Order #100000000000 shipped",
    "Total: 129900",
    "Founded in 2001 by two engineers",
    "SKU 4111111111111112 out of stock",
    "thanks @teammate for the review",
    "Showing 1234 of 5678 results",
]


def element(**overrides: Any) -> dict:
    base = {
        "id": 1,
        "role": "textbox",
        "bbox": [10, 20, 200, 32],
    }
    base.update(overrides)
    return base


def sanitized_request(**overrides: Any) -> dict:
    """A well-formed, fully sanitized payload — the happy path."""
    base = {
        "session_id": "test-session",
        "task": "Fill this form with my profile and stop before submitting",
        "step": 0,
        "disclosure_level": 2,
        "page": {"origin": "https://demo.local", "path": "/apply", "title": "Application"},
        "elements": [
            element(id=1, label="Full name", sensitive="NAME", filled=False),
            element(id=2, label="Email address", sensitive="EMAIL", filled=False),
            element(id=3, label="Portal password", sensitive="PASSWORD", type="password", filled=False),
            element(id=4, label="Referral code", value="NSP2026", filled=True),
            element(id=5, role="button", text="Submit application", bbox=[10, 400, 160, 40]),
        ],
        "redactions": [
            {"token": "⟦AADHAAR_1⟧", "type": "AADHAAR", "bbox": [10, 60, 180, 24], "source": "dom-field"}
        ],
        "profile_keys": ["FULL_NAME", "EMAIL", "PHONE"],
        "history": [],
    }
    base.update(overrides)
    return base

"""The server's own validators must agree with the client's on the cases that matter."""

from __future__ import annotations

import pytest

from app.validators import (
    is_luhn_valid,
    is_pan_valid,
    is_token,
    is_verhoeff_valid,
    scan_text,
)

from .fixtures import FAKE, NOT_PII


class TestChecksums:
    def test_verhoeff_accepts_valid_aadhaar(self):
        assert is_verhoeff_valid(FAKE["aadhaar"])
        assert is_verhoeff_valid(FAKE["aadhaar_spaced"])

    def test_verhoeff_rejects_bad_check_digit(self):
        assert not is_verhoeff_valid(FAKE["aadhaar_bad"])

    def test_verhoeff_catches_every_single_digit_typo(self):
        digits = list(FAKE["aadhaar"])
        for i, digit in enumerate(digits):
            wrong = digits.copy()
            wrong[i] = str((int(digit) + 1) % 10)
            assert not is_verhoeff_valid("".join(wrong)), f"typo at {i} slipped through"

    def test_verhoeff_requires_twelve_digits(self):
        assert not is_verhoeff_valid("22345678901")
        assert not is_verhoeff_valid("")

    def test_luhn(self):
        assert is_luhn_valid(FAKE["card"])
        assert not is_luhn_valid(FAKE["card_bad"])

    def test_pan_holder_type(self):
        assert is_pan_valid(FAKE["pan"])
        assert not is_pan_valid(FAKE["pan_bad"])


class TestScan:
    @pytest.mark.parametrize(
        "text,expected",
        [
            (f"mail {FAKE['email']}", "EMAIL"),
            (f"call {FAKE['phone']}", "PHONE"),
            (f"uid {FAKE['aadhaar_spaced']}", "AADHAAR"),
            (f"card {FAKE['card']}", "CARD"),
            (f"pan {FAKE['pan']}", "PAN"),
            (f"ifsc {FAKE['ifsc']}", "IFSC"),
            (f"vpa {FAKE['upi']}", "UPI"),
        ],
    )
    def test_finds_unmistakable_pii(self, text, expected):
        assert expected in [m.type for m in scan_text(text)]

    @pytest.mark.parametrize("text", NOT_PII)
    def test_leaves_ordinary_text_alone(self, text):
        assert scan_text(text) == []

    def test_rejects_failed_checksums(self):
        assert "AADHAAR" not in [m.type for m in scan_text(FAKE["aadhaar_bad"])]
        assert "CARD" not in [m.type for m in scan_text(FAKE["card_bad"])]
        assert "PAN" not in [m.type for m in scan_text(FAKE["pan_bad"])]

    def test_card_wins_over_the_digits_inside_it(self):
        matches = scan_text(f"card {FAKE['card']}")
        assert len(matches) == 1
        assert matches[0].type == "CARD"

    def test_unknown_upi_handle_is_not_flagged(self):
        # Without page context the server cannot tell this from a social @mention.
        assert scan_text("ping @someuser") == []

    def test_tokens_are_recognised(self):
        assert is_token("⟦EMAIL_1⟧")
        assert is_token("⟦PROFILE.FULL_NAME⟧")
        assert not is_token("not a token")
        assert not is_token("⟦EMAIL_1⟧ and more")

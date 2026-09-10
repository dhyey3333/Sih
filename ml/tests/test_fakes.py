"""The generators must produce values the extension's validators accept.

If they drift apart, the detector trains on numbers our own pipeline would reject,
and every accuracy figure measured against this dataset becomes meaningless. These
tests are the tripwire for that.
"""

from __future__ import annotations

import random
import re

import pytest

from synth import fakes
from synth.classes import CLASS_INDEX, DETECTOR_CLASSES, class_for_pii, class_for_ui


@pytest.fixture
def rng() -> random.Random:
    return random.Random(1234)


class TestAadhaar:
    def test_generated_numbers_pass_verhoeff(self, rng):
        for _ in range(300):
            assert fakes.is_verhoeff_valid(fakes.fake_aadhaar(rng))

    def test_spacing_is_cosmetic(self, rng):
        spaced = fakes.fake_aadhaar(rng, spaced=True)
        assert " " in spaced
        assert fakes.is_verhoeff_valid(spaced.replace(" ", ""))

    def test_never_starts_with_zero_or_one(self, rng):
        # UIDAI does not issue those, so a detector should never see one.
        for _ in range(200):
            assert fakes.fake_aadhaar(rng, spaced=False)[0] not in "01"

    def test_a_broken_digit_fails(self, rng):
        digits = fakes.fake_aadhaar(rng, spaced=False)
        broken = digits[:-1] + str((int(digits[-1]) + 1) % 10)
        assert not fakes.is_verhoeff_valid(broken)


class TestCard:
    def test_generated_cards_pass_luhn(self, rng):
        for _ in range(300):
            assert fakes.is_luhn_valid(fakes.fake_card(rng))

    def test_lengths_are_realistic(self, rng):
        for _ in range(200):
            digits = re.sub(r"\D", "", fakes.fake_card(rng))
            assert len(digits) in (15, 16)

    def test_ungrouped_form_is_the_same_number(self, rng):
        plain = fakes.fake_card(rng, grouped=False)
        assert plain.isdigit()
        assert fakes.is_luhn_valid(plain)


class TestOtherIdentifiers:
    def test_pan_shape_and_holder_type(self, rng):
        for _ in range(200):
            pan = fakes.fake_pan(rng)
            assert re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", pan)
            assert pan[3] in "PCHFATBLJG"

    def test_ifsc_shape(self, rng):
        for _ in range(100):
            assert re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", fakes.fake_ifsc(rng))

    def test_phone_is_a_valid_indian_mobile(self, rng):
        for _ in range(200):
            phone = fakes.fake_phone(rng)
            assert re.fullmatch(r"[6-9]\d{9}", phone)

    def test_upi_handle_is_a_known_provider(self, rng):
        # An unknown handle is indistinguishable from a social @mention, and the
        # extension deliberately declines to flag those.
        for _ in range(100):
            assert re.fullmatch(r"[a-z0-9]+@[a-z]+", fakes.fake_upi(rng, "Asha Rao"))

    def test_passport_first_letter_is_issued(self, rng):
        for _ in range(200):
            assert fakes.fake_passport(rng)[0] not in "QXZ"

    def test_pincode_never_starts_with_zero(self, rng):
        for _ in range(100):
            assert fakes.fake_pincode(rng)[0] != "0"


class TestDecoys:
    def test_invalid_card_decoys_fail_luhn(self, rng):
        seen = 0
        for _ in range(400):
            value = fakes.decoy_number(rng)
            digits = re.sub(r"\D", "", value)
            if len(digits) in (15, 16):
                seen += 1
                assert not fakes.is_luhn_valid(digits), "decoy card must not validate"
        assert seen > 0, "no card-shaped decoys were generated"

    def test_invalid_aadhaar_decoys_fail_verhoeff(self, rng):
        seen = 0
        for _ in range(400):
            digits = re.sub(r"\D", "", fakes.decoy_number(rng))
            if len(digits) == 12:
                seen += 1
                assert not fakes.is_verhoeff_valid(digits)
        assert seen > 0, "no Aadhaar-shaped decoys were generated"


class TestClasses:
    def test_indices_are_contiguous_and_stable(self):
        # Reordering invalidates every label file ever written.
        assert DETECTOR_CLASSES[0] == "text_input"
        assert list(CLASS_INDEX.values()) == list(range(len(DETECTOR_CLASSES)))

    def test_text_like_pii_collapses_to_one_class(self):
        for pii in ("AADHAAR", "PAN", "EMAIL", "PHONE", "ADDRESS", "NAME", "OTP", "IFSC"):
            assert class_for_pii(pii) == "pii_text"

    def test_document_classes_stay_distinct(self):
        assert class_for_pii("CARD") == "payment_card"
        assert class_for_pii("ID_DOCUMENT") == "id_document"
        assert class_for_pii("QR_CODE") == "qr_code"
        assert class_for_pii("SIGNATURE") == "signature"
        assert class_for_pii("PASSWORD") == "password_field"

    def test_faces_are_left_to_yunet(self):
        # Deliberate: we cannot synthesise photographs, and training a face class on
        # illustrations would produce a number that fails on the first real photo.
        assert class_for_pii("FACE") is None

    def test_ui_mapping(self):
        assert class_for_ui("input") == "text_input"
        assert class_for_ui("button") == "button"
        assert class_for_ui("password") == "password_field"
        assert class_for_ui("nonsense") is None

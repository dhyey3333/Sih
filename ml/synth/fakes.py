"""Fake PII that passes the same checks the real thing does.

Every value here is synthetic. The Aadhaar numbers satisfy Verhoeff, the cards
satisfy Luhn and the PANs carry a valid holder-type letter — not to be clever, but
because a detector trained on numbers our own validators reject would be trained on
the wrong distribution, and the eval numbers would be meaningless.

Mirrors `extension/lib/pii/checksums.ts`. `tests/test_fakes.py` checks the two agree.
"""

from __future__ import annotations

import random
import string

# --- Verhoeff (Aadhaar) ------------------------------------------------------

_D5_MUL = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)

_D5_PERM = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)

_D5_INV = (0, 4, 3, 2, 1, 5, 6, 7, 8, 9)


def verhoeff_check_digit(body: str) -> int:
    """Check digit for an 11-digit body."""
    c = 0
    for i, digit in enumerate(reversed([int(d) for d in body if d.isdigit()])):
        c = _D5_MUL[c][_D5_PERM[(i + 1) % 8][digit]]
    return _D5_INV[c]


def is_verhoeff_valid(value: str) -> bool:
    digits = [int(d) for d in value if d.isdigit()]
    if len(digits) != 12:
        return False
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = _D5_MUL[c][_D5_PERM[i % 8][digit]]
    return c == 0


def fake_aadhaar(rng: random.Random, spaced: bool = True) -> str:
    """A Verhoeff-valid 12-digit number. Never starts with 0 or 1, as UIDAI requires."""
    body = str(rng.randint(2, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(10))
    full = body + str(verhoeff_check_digit(body))
    return f"{full[:4]} {full[4:8]} {full[8:]}" if spaced else full


# --- Luhn (payment cards) ----------------------------------------------------

def luhn_check_digit(body: str) -> int:
    total = 0
    for i, digit in enumerate(reversed([int(d) for d in body])):
        # The body is one short of the full number, so the doubling parity flips.
        if i % 2 == 0:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return (10 - total % 10) % 10


def is_luhn_valid(value: str) -> bool:
    digits = [int(d) for d in value if d.isdigit()]
    if not 12 <= len(digits) <= 19:
        return False
    total = 0
    for i, digit in enumerate(reversed(digits)):
        if i % 2:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


#: (prefix, total length) per scheme. Real IIN ranges, fake accounts.
_CARD_SCHEMES = (("4", 16), ("51", 16), ("55", 16), ("34", 15), ("37", 15), ("6521", 16))


def fake_card(rng: random.Random, grouped: bool = True) -> str:
    prefix, length = rng.choice(_CARD_SCHEMES)
    body = prefix + "".join(str(rng.randint(0, 9)) for _ in range(length - len(prefix) - 1))
    full = body + str(luhn_check_digit(body))
    if not grouped:
        return full
    if length == 15:  # Amex groups 4-6-5
        return f"{full[:4]} {full[4:10]} {full[10:]}"
    return " ".join(full[i : i + 4] for i in range(0, len(full), 4))


# --- Other Indian identifiers ------------------------------------------------

#: 4th character encodes holder type; P is an individual.
_PAN_HOLDER_TYPES = "PCHFATBLJG"

_IFSC_BANKS = ("HDFC", "ICIC", "SBIN", "UTIB", "KKBK", "PUNB", "BARB", "CNRB", "IDIB", "YESB")

_UPI_HANDLES = (
    "okhdfcbank", "okicici", "oksbi", "okaxis", "ybl", "paytm", "apl", "ibl", "axl",
)


def fake_pan(rng: random.Random) -> str:
    letters = "".join(rng.choice(string.ascii_uppercase) for _ in range(3))
    holder = rng.choice(_PAN_HOLDER_TYPES)
    surname_initial = rng.choice(string.ascii_uppercase)
    digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    return f"{letters}{holder}{surname_initial}{digits}{rng.choice(string.ascii_uppercase)}"


def fake_ifsc(rng: random.Random) -> str:
    bank = rng.choice(_IFSC_BANKS)
    branch = "".join(rng.choice(string.digits + string.ascii_uppercase) for _ in range(6))
    return f"{bank}0{branch}"


def fake_upi(rng: random.Random, name: str) -> str:
    handle = name.split()[0].lower() if name else "user"
    handle = "".join(c for c in handle if c.isalnum()) or "user"
    return f"{handle}{rng.randint(1, 999)}@{rng.choice(_UPI_HANDLES)}"


def fake_passport(rng: random.Random) -> str:
    # Q, X and Z are not issued as the first letter of an Indian passport number.
    first = rng.choice("ABCDEFGHIJKLMNOPRSTUVWY")
    return first + "".join(str(rng.randint(0, 9)) for _ in range(7))


def fake_phone(rng: random.Random, with_code: bool = False) -> str:
    number = str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    return f"+91 {number}" if with_code else number


def fake_pincode(rng: random.Random) -> str:
    return str(rng.randint(110001, 855117))


def fake_otp(rng: random.Random) -> str:
    return "".join(str(rng.randint(0, 9)) for _ in range(rng.choice((4, 6))))


def fake_cvv(rng: random.Random) -> str:
    return "".join(str(rng.randint(0, 9)) for _ in range(3))


def fake_account_number(rng: random.Random) -> str:
    return "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(9, 16)))


def fake_dob(rng: random.Random) -> str:
    day, month, year = rng.randint(1, 28), rng.randint(1, 12), rng.randint(1955, 2006)
    return f"{day:02d}/{month:02d}/{year}"


# --- Decoys ------------------------------------------------------------------

def is_accidentally_valid(value: str) -> bool:
    """
    Would our own validators flag this "decoy"?

    A random 12-digit order number satisfies Verhoeff about one time in ten, and a
    random 16-digit reference satisfies Luhn about one time in ten. Left unchecked,
    roughly that share of the negatives in the dataset are labelled "not PII" while
    the extension would correctly detect them — teaching the detector that real
    Aadhaar and card numbers are safe. Silent, and it would only show up as an
    unexplained recall ceiling much later.
    """
    digits = "".join(c for c in value if c.isdigit())
    if len(digits) == 12 and is_verhoeff_valid(digits):
        return True
    if 13 <= len(digits) <= 19 and is_luhn_valid(digits):
        return True
    return False


def _raw_decoy(rng: random.Random) -> str:
    kind = rng.choice(("order", "amount", "count", "invalid_card", "invalid_aadhaar", "year"))
    if kind == "order":
        return f"{rng.randint(10**9, 10**12)}"
    if kind == "amount":
        return f"₹{rng.randint(100, 999999):,}"
    if kind == "count":
        return f"{rng.randint(1000, 99999)}"
    if kind == "invalid_card":
        # Luhn-valid then broken, so it is structurally a card and fails the check.
        card = fake_card(rng, grouped=False)
        broken = card[:-1] + str((int(card[-1]) + 1) % 10)
        return " ".join(broken[i : i + 4] for i in range(0, len(broken), 4))
    if kind == "invalid_aadhaar":
        digits = fake_aadhaar(rng, spaced=False)
        broken = digits[:-1] + str((int(digits[-1]) + 1) % 10)
        return f"{broken[:4]} {broken[4:8]} {broken[8:]}"
    return str(rng.randint(1990, 2030))


def decoy_number(rng: random.Random) -> str:
    """
    A number that must NOT be detected.

    Negatives matter as much as positives. Without them the model learns "long digit
    run = PII" and precision collapses on any page carrying an order id or a
    transaction reference — which is most pages.

    Every candidate is re-checked against the real checksums, so a decoy can never
    accidentally be a valid Aadhaar or card number.
    """
    for _ in range(20):
        candidate = _raw_decoy(rng)
        if not is_accidentally_valid(candidate):
            return candidate
    # Unreachable in practice; a short number cannot satisfy either checksum.
    return str(rng.randint(1000, 99999))

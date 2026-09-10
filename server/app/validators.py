"""PII validators, server side.

A deliberate second implementation of the high-confidence rules in
``extension/lib/pii/validators.ts``. It exists so that a bug in the client cannot
turn into a leak on the server: if raw PII arrives, we refuse the request rather
than forwarding it to a third-party VLM.

Only the rules that need no surrounding context are ported. The client's
context-dependent rules (OTP, CVV, PIN code) are about *classifying* ambiguous
digits; this module is about *catching* unmistakable values, and a bare 4-digit
number is not one.

Nothing here logs or raises with a value in it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- checksums ---------------------------------------------------------------

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


def is_verhoeff_valid(value: str) -> bool:
    """Verhoeff check, as UIDAI uses for Aadhaar. Exactly 12 digits."""
    digits = [int(c) for c in value if c.isdigit()]
    if len(digits) != 12:
        return False
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = _D5_MUL[c][_D5_PERM[i % 8][digit]]
    return c == 0


def is_luhn_valid(value: str) -> bool:
    """Luhn (mod 10) check for payment cards."""
    digits = [int(c) for c in value if c.isdigit()]
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


#: The 4th character of a PAN encodes the holder type.
_PAN_HOLDER_TYPES = set("PCHFATBLJG")


def is_pan_valid(value: str) -> bool:
    value = value.upper()
    if not re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", value):
        return False
    return value[3] in _PAN_HOLDER_TYPES


# --- rules -------------------------------------------------------------------

_UPI_HANDLES = {
    "okhdfcbank", "okicici", "oksbi", "okaxis", "ybl", "ibl", "axl", "apl",
    "paytm", "upi", "sbi", "hdfcbank", "icici", "axisbank", "kotak", "pnb",
    "barodampay", "fbl", "idfcbank", "yesg", "abfspay", "airtel", "freecharge",
    "jio", "jupiteraxis", "naviaxis", "superyes", "timecosmos", "waaxis",
    "wasbi", "waicici", "rmhdfc", "indus", "cnrb", "uco", "unionbank",
}


@dataclass(frozen=True)
class Rule:
    type: str
    name: str
    pattern: re.Pattern[str]
    validate: object = None  # Callable[[str], bool] | None


RULES: tuple[Rule, ...] = (
    Rule("EMAIL", "email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")),
    Rule(
        "AADHAAR",
        "aadhaar-verhoeff",
        re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)"),
        is_verhoeff_valid,
    ),
    Rule(
        "CARD",
        "card-luhn",
        re.compile(r"(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)"),
        is_luhn_valid,
    ),
    Rule("PAN", "pan-structure", re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b"), is_pan_valid),
    Rule("IFSC", "ifsc", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),
    Rule("PHONE", "phone-in", re.compile(r"(?<![\d-])(?:\+?91[\s-]?)?[6-9]\d{9}(?![\d-])")),
    Rule("UPI", "upi-vpa", re.compile(r"\b[A-Za-z0-9._-]{2,60}@[A-Za-z]{2,20}\b")),
)

#: Priority, for resolving overlaps. Matches PII_PRIORITY in protocol.ts.
_PRIORITY = {
    "AADHAAR": 95, "PAN": 94, "CARD": 93, "IFSC": 80,
    "UPI": 79, "EMAIL": 70, "PHONE": 69,
}

_TOKEN_RE = re.compile(r"^⟦[A-Z][A-Z0-9_.]*⟧$")


def is_token(value: str) -> bool:
    return bool(_TOKEN_RE.match(value.strip()))


@dataclass(frozen=True)
class Match:
    type: str
    rule: str
    start: int
    end: int


def scan_text(text: str) -> list[Match]:
    """Find unmistakable PII in ``text``. Overlaps resolved by priority, then length."""
    if not text:
        return []

    candidates: list[Match] = []
    for rule in RULES:
        for m in rule.pattern.finditer(text):
            value = m.group(0)
            if rule.validate is not None and not rule.validate(value):  # type: ignore[operator]
                continue
            if rule.type == "UPI":
                provider = value.split("@", 1)[1].lower()
                # Without a known provider this is indistinguishable from an
                # @mention, and the server has no surrounding context to judge by.
                if provider not in _UPI_HANDLES:
                    continue
            candidates.append(Match(rule.type, rule.name, m.start(), m.end()))

    candidates.sort(key=lambda c: (-_PRIORITY.get(c.type, 0), -(c.end - c.start), c.start))

    kept: list[Match] = []
    for candidate in candidates:
        if not any(candidate.start < k.end and k.start < candidate.end for k in kept):
            kept.append(candidate)
    return sorted(kept, key=lambda c: c.start)

"""The detector's class list, and how page annotations map onto it.

**Why there is no `face` class.**

Faces are already handled by YuNet, which was trained on real photographs and
measures 0.83–0.91 confidence on them (docs/PROGRESS.md). We cannot synthesise
photographs — the repo may not contain anyone's face, and an illustrated stand-in
would teach the model to find drawings, not people. Training a face class on
synthetic data would produce a number that looks good on our own validation split
and fails on the first real profile picture. So faces stay with YuNet, and this
detector covers what the DOM cannot see *and* we can honestly generate.

**What it is for.** The DOM layer already handles DOM-rendered pages exactly and in
microseconds. This model exists for the cases the DOM is empty: canvas-rendered
apps, PDF pages, screenshots-of-screens, cross-origin frames. `text_input` and
`button` are what let the agent act on those at all; `pii_text` and the document
classes are what let it redact them.
"""

from __future__ import annotations

#: Order is the label index. Appending is safe; reordering invalidates every dataset.
DETECTOR_CLASSES: tuple[str, ...] = (
    "text_input",
    "button",
    "password_field",
    "pii_text",
    "payment_card",
    "id_document",
    "qr_code",
    "signature",
)

CLASS_INDEX: dict[str, int] = {name: i for i, name in enumerate(DETECTOR_CLASSES)}

#: `data-pii` value (the extension's PII taxonomy) → detector class.
#: Everything text-shaped collapses to `pii_text`: the model's job is "there is a
#: secret here", and deciding *which kind* is the validators' job, which they do
#: far more reliably from characters than a detector can from pixels.
PII_TO_CLASS: dict[str, str] = {
    "PASSWORD": "password_field",
    "CARD": "payment_card",
    "CVV": "payment_card",
    "ID_DOCUMENT": "id_document",
    "QR_CODE": "qr_code",
    "SIGNATURE": "signature",
    "AADHAAR": "pii_text",
    "PAN": "pii_text",
    "PASSPORT": "pii_text",
    "IFSC": "pii_text",
    "UPI": "pii_text",
    "ACCOUNT": "pii_text",
    "EMAIL": "pii_text",
    "PHONE": "pii_text",
    "OTP": "pii_text",
    "DOB": "pii_text",
    "PINCODE": "pii_text",
    "ADDRESS": "pii_text",
    "NAME": "pii_text",
    "GENERIC": "pii_text",
    # Deliberately unmapped: see the module docstring.
    "FACE": None,  # type: ignore[dict-item]
}

#: `data-ui` value → detector class, for the interactive elements.
UI_TO_CLASS: dict[str, str] = {
    "input": "text_input",
    "button": "button",
    "password": "password_field",
}


def class_for_pii(pii_type: str) -> str | None:
    """Detector class for a `data-pii` annotation, or None if it has none."""
    return PII_TO_CLASS.get(pii_type.upper())


def class_for_ui(ui_type: str) -> str | None:
    return UI_TO_CLASS.get(ui_type.lower())

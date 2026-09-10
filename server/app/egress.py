"""Inbound guard.

The client runs an egress guard immediately before ``fetch``. This is the same
check on arrival, and it exists for one reason: a bug in the client must not be
able to leak PII onwards to a third-party VLM. If raw PII reaches us, we refuse
the request loudly instead of quietly forwarding it.

Incidents carry the PII *type* and the JSON path. Never the value.
"""

from __future__ import annotations

from typing import Any

from .schemas import EgressIncident
from .validators import is_token, scan_text

#: The screenshot is base64 JPEG bytes. Text validators over it are meaningless —
#: PII in an image is not ASCII in the compressed stream — and across a megabyte of
#: random-looking digits a Luhn-valid run appears by chance and would reject every
#: request. Pixel redaction protects the image; the OCR leak test in eval/ verifies it.
SKIPPED_PATHS = frozenset({"screen.image_jpeg_b64"})

#: Strings longer than this are truncated before scanning, not skipped.
MAX_SCAN_CHARS = 20_000


def scan_payload(payload: Any, *, skip_paths: frozenset[str] = SKIPPED_PATHS) -> list[EgressIncident]:
    """Walk every string in ``payload`` and report anything that looks like raw PII."""
    incidents: list[EgressIncident] = []

    def visit(node: Any, path: str) -> None:
        if node is None:
            return
        if isinstance(node, str):
            if path in skip_paths:
                return
            scan_string(node, path)
        elif isinstance(node, (list, tuple)):
            for i, child in enumerate(node):
                visit(child, f"{path}[{i}]")
        elif isinstance(node, dict):
            for key, child in node.items():
                visit(child, f"{path}.{key}" if path else str(key))

    def scan_string(value: str, path: str) -> None:
        # A bare token is the expected shape of a sanitized value.
        if not value or is_token(value):
            return
        text = value[:MAX_SCAN_CHARS]
        for match in scan_text(text):
            incidents.append(EgressIncident(type=match.type, path=path, rule=match.rule))

    visit(payload, "")
    return incidents


def describe(incidents: list[EgressIncident]) -> str:
    """One-line summary for logs. Contains no values."""
    if not incidents:
        return "clean"
    counts: dict[str, int] = {}
    for incident in incidents:
        counts[incident.type] = counts.get(incident.type, 0) + 1
    return ", ".join(f"{t}x{n}" for t, n in sorted(counts.items()))

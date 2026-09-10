"""Prompt construction.

The prompt is where the redaction scheme is *explained* to the model. The problem
statement requires the server to be "aware of this redaction scheme and process
data accordingly" — this file is that awareness. Get it wrong and the model tries
to read a black box, or invents an Aadhaar number to type.

Three rules do most of the work:
  1. A ⟦TOKEN⟧ is a real value that was removed. Never guess what is behind it.
  2. To make the user type one of their own values, emit the token. The extension
     swaps it for the real value locally, after this response leaves the server.
  3. Act through element ids, which are drawn on the screenshot as blue badges.
     Never return pixel coordinates for something that has an id.
"""

from __future__ import annotations

import json

from .schemas import StepRequest

SYSTEM_PROMPT = """\
You are the reasoning half of a privacy-preserving browser agent. The other half \
runs on the user's machine and has already removed every piece of personal data \
from what you are about to see. You decide the single next UI action.

THE REDACTION SCHEME — read this carefully, everything depends on it.

Before anything reached you, the extension detected sensitive content on the \
user's screen, painted it out of the screenshot, and replaced it in the text with \
a token of the form ⟦TYPE_N⟧ or ⟦PROFILE.KEY⟧.

* ⟦EMAIL_1⟧, ⟦AADHAAR_1⟧, ⟦CARD_2⟧ … a real value that was removed. The same \
  token always means the same value, so you can tell when two fields hold the same \
  thing. You cannot see the value and must never guess it or invent a substitute.
* ⟦PROFILE.EMAIL⟧, ⟦PROFILE.FULL_NAME⟧ … a value the user has stored locally. \
  `profile_keys` lists which ones exist. To fill a field with one, put the token in \
  the `text` field of a `type` action. The extension resolves it locally, after \
  your response leaves this server. This is how the user's data gets typed without \
  you ever seeing it.
* A solid black box in the screenshot is redacted text. A pixelated area is a face. \
  `redactions` tells you what each box was.
* An element with `"sensitive": "PASSWORD"` has no token at all — a password is \
  never read out of the page. `filled` tells you whether it already has content. \
  Never attempt to type a password.

HOW TO ACT

Every interactive element is numbered, and the number is drawn on the screenshot as \
a blue badge in its top-left corner. Refer to elements by `element_id`. Only use \
`click_xy` for something with no id at all (canvas, video, a PDF page).

Actions, one per response:
  {"action": "click", "element_id": 12}
  {"action": "type", "element_id": 5, "text": "⟦PROFILE.EMAIL⟧"}
  {"action": "type", "element_id": 6, "text": "Mumbai"}
  {"action": "select", "element_id": 8, "option": "Female"}
  {"action": "scroll", "direction": "down", "amount": 600}
  {"action": "key", "element_id": 5, "key": "Enter"}
  {"action": "click_xy", "x": 410, "y": 260}
  {"action": "wait", "ms": 500}
  {"action": "ask_user", "question": "..."}
  {"action": "done", "summary": "..."}

RULES

1. Return exactly one JSON object. No prose, no markdown fence, no explanation \
   outside the object. Always include a short `reason`.
2. Never guess a redacted value. If you need one and no profile key provides it, \
   use `ask_user`.
3. Do not click anything irreversible — submit, pay, send, delete, transfer, place \
   order, confirm — on your own. Use `ask_user` and let the person decide. The \
   extension will refuse the click anyway, so acting otherwise just wastes a step.
4. Skip fields that are already filled unless the task says to change them.
5. If the task is complete, or nothing useful remains, return `done` with a summary.
6. `history` shows what has already been tried. If an action failed twice, do \
   something different rather than repeating it.
"""


def build_user_message(request: StepRequest) -> str:
    """The text half of the user turn. The image, when present, is attached beside it."""
    elements = [
        {k: v for k, v in element.model_dump().items() if v is not None}
        for element in request.elements
    ]
    redactions = [
        {"token": r.token, "type": r.type, "bbox": [round(v) for v in r.bbox]}
        for r in request.redactions
    ]

    parts = [
        f"TASK: {request.task}",
        f"STEP: {request.step}",
        f"PAGE: {request.page.origin}{request.page.path}"
        + (f" — {request.page.title}" if request.page.title else ""),
    ]

    if request.disclosure_level < 2:
        parts.append(
            "NOTE: no screenshot this step. The page was judged too sensitive, or "
            "redaction covered too much of it to be worth sending. Work from the "
            "element list and their bounding boxes alone."
        )

    parts.append(f"PROFILE KEYS AVAILABLE: {', '.join(request.profile_keys) or '(none)'}")
    parts.append(f"REDACTIONS ON THIS SCREEN:\n{json.dumps(redactions, ensure_ascii=False)}")
    parts.append(f"ELEMENTS:\n{json.dumps(elements, ensure_ascii=False)}")

    if request.history:
        recent = [h.model_dump(exclude_none=True) for h in request.history[-8:]]
        parts.append(f"HISTORY (most recent last):\n{json.dumps(recent, ensure_ascii=False)}")

    parts.append("Respond with exactly one JSON action object.")
    return "\n\n".join(parts)

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

from .planner import is_question
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
  {"action": "navigate", "url": "/apply/step-2"}
  {"action": "navigate", "url": "back"}
  {"action": "wait", "ms": 500}
  {"action": "ask_user", "element_id": 9, "question": "What is your father's name?"}
  {"action": "ask_user", "question": "..."}
  {"action": "done", "summary": "..."}

`select` also works on a radio-button group: name any radio in the group and give \
the option's label. To fill a field the profile cannot cover, use `ask_user` with \
that field's `element_id`: the user types the answer locally and you will only ever \
see a token for it. `navigate` stays on the current site unless the user approves; \
prefer clicking a visible "Next" or link over guessing a URL.

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
7. If the task is a question about the page, do not click or type anything: return \
   `done` with the answer in `summary`, using the words and numbers exactly as the \
   SCREEN TEXT shows them. If the answer is behind a token, name the token — never \
   guess what it hides.
8. The user talks to you as in a chat. EARLIER IN THIS CONVERSATION, when present, \
   lists their previous requests and how each ended; use it to understand a \
   follow-up ("now the next page", "what did you fill?"). The TASK is what to do now, \
   and the irreversible-action rule applies however a follow-up is worded.
"""


def _element(element) -> dict:
    out = {k: v for k, v in element.model_dump().items() if v is not None}
    out["bbox"] = [round(v) for v in element.bbox]
    # A checkbox's value is its form value ("on"), not its state; `checked` is the state.
    if element.role in {"checkbox", "radio"}:
        out.pop("value", None)
        out.pop("filled", None)
    return out


def build_user_message(request: StepRequest, image_attached: bool | None = None) -> str:
    """The text half of the user turn. The image, when present, is attached beside it."""
    if image_attached is None:
        image_attached = request.screen is not None
    elements = [_element(element) for element in request.elements]
    redactions = [
        {"token": r.token, "type": r.type, "bbox": [round(v) for v in r.bbox]}
        for r in request.redactions
    ]

    parts = []
    if request.conversation:
        earlier = "\n".join(
            f"- user: {turn.task}" + (f"\n  you: {turn.summary}" if turn.summary else "")
            for turn in request.conversation
        )
        parts.append(f"EARLIER IN THIS CONVERSATION (oldest first):\n{earlier}")
    parts += [
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
    elif not image_attached:
        parts.append(
            "NOTE: no screenshot this step — the element list and the screen text below "
            "describe everything on the page. Refer to elements by id."
        )

    parts.append(f"PROFILE KEYS AVAILABLE: {', '.join(request.profile_keys) or '(none)'}")
    parts.append(f"REDACTIONS ON THIS SCREEN:\n{json.dumps(redactions, ensure_ascii=False)}")
    parts.append(f"ELEMENTS:\n{json.dumps(elements, ensure_ascii=False)}")

    if request.visible_text:
        # Plain lines, not JSON: this is for reading, and escaping every quote in a
        # paragraph costs a small model more than it helps.
        parts.append(
            "SCREEN TEXT (reading order; personal data already replaced by tokens):\n"
            + request.visible_text
        )
    if request.page.more_below:
        parts.append("The page continues below what is on screen; scroll down to see more of it.")

    if request.history:
        recent = [h.model_dump(exclude_none=True) for h in request.history[-8:]]
        parts.append(f"HISTORY (most recent last):\n{json.dumps(recent, ensure_ascii=False)}")

    if is_question(request.task):
        # Small models read "answer from the screen" in the system prompt and then go
        # exploring anyway — eight steps of scrolling on a page that held the answer.
        parts.append(
            "THIS TASK IS A QUESTION. Do not click, type or scroll. Reply now with "
            '{"action": "done", "summary": "<the answer, in the words of the SCREEN TEXT>"}. '
            "If the answer is behind a token, the token is the answer."
        )
    parts.append("Respond with exactly one JSON action object.")
    return "\n\n".join(parts)

"""Wire schemas.

Mirrors ``extension/lib/protocol.ts``. If you change one, change the other —
``tests/test_schemas.py`` checks the two taxonomies have not drifted apart.

Nothing in here should ever hold a real PII value. Every field that could is
either a token (``⟦EMAIL_1⟧``) or has already been through the client's sanitizer.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

PiiType = Literal[
    "PASSWORD",
    "AADHAAR",
    "PAN",
    "CARD",
    "CVV",
    "PASSPORT",
    "IFSC",
    "UPI",
    "ACCOUNT",
    "EMAIL",
    "PHONE",
    "OTP",
    "DOB",
    "PINCODE",
    "ADDRESS",
    "NAME",
    "FACE",
    "ID_DOCUMENT",
    "QR_CODE",
    "SIGNATURE",
    "GENERIC",
]

DetectionSource = Literal["dom-field", "dom-text", "dom-image", "vision", "ocr"]

ActionName = Literal[
    "click",
    "click_xy",
    "type",
    "select",
    "scroll",
    "key",
    "navigate",
    "wait",
    "ask_user",
    "done",
]

#: ``[x, y, w, h]`` in CSS pixels, viewport-relative.
BBox = Annotated[list[float], Field(min_length=4, max_length=4)]


class Page(BaseModel):
    """Origin + path only. The client strips query strings and fragments."""

    origin: str
    path: str
    title: str = ""
    #: The page continues below the fold.
    more_below: bool = False


class Screen(BaseModel):
    image_jpeg_b64: str
    width: int
    height: int


class WireElement(BaseModel):
    id: int
    role: str
    label: str | None = None
    text: str | None = None
    placeholder: str | None = None
    #: A token, or a literal that passed the client's sanitizer.
    value: str | None = None
    type: str | None = None
    options: list[str] | None = None
    bbox: BBox
    disabled: bool | None = None
    required: bool | None = None
    checked: bool | None = None
    #: A radio button's group (its ``name``), so a group is asked about as one.
    group: str | None = None
    sensitive: PiiType | None = None
    #: Whether a sensitive field already has content. Passwords have this and no value.
    filled: bool | None = None


class WireRedaction(BaseModel):
    token: str
    type: PiiType
    bbox: BBox
    source: DetectionSource


class HistoryEntry(BaseModel):
    action: str
    #: Origin + path of the page the step was taken on. Element ids are stable only
    #: within a page, so history from another page never matches an id here.
    page: str | None = None
    element_id: int | None = None
    text: str | None = None
    ok: bool
    error: str | None = None


class ConversationTurn(BaseModel):
    """An earlier task in this panel session and how it ended — sanitized like the task."""

    task: str = Field(max_length=500)
    summary: str | None = Field(default=None, max_length=600)


class StepRequest(BaseModel):
    session_id: str
    task: str
    #: Earlier turns, oldest first, so "now submit it" or "what did you fill?" can be
    #: understood. Tokens only: the client sanitizes every turn like the task itself.
    conversation: list[ConversationTurn] = Field(default_factory=list, max_length=6)
    step: int = 0
    #: 0 local-only, 1 structure-only, 2 sanitized image + structure.
    disclosure_level: Literal[0, 1, 2] = 2
    page: Page
    #: Absent at disclosure levels 0 and 1.
    screen: Screen | None = None
    elements: list[WireElement] = Field(default_factory=list)
    redactions: list[WireRedaction] = Field(default_factory=list)
    #: Which profile keys the client holds — never their values.
    profile_keys: list[str] = Field(default_factory=list)
    history: list[HistoryEntry] = Field(default_factory=list)
    #: The screen's text in reading order, every detected value already a token.
    #: Level 2 only, where the redacted screenshot showing the same text is sent too.
    visible_text: str | None = Field(default=None, max_length=8000)


class StepResponse(BaseModel):
    action: ActionName
    element_id: int | None = None
    x: float | None = None
    y: float | None = None
    text: str | None = None
    option: str | None = None
    direction: Literal["up", "down", "left", "right"] | None = None
    amount: int | None = None
    key: str | None = None
    url: str | None = None
    ms: int | None = None
    question: str | None = None
    summary: str | None = None
    reason: str | None = None
    confidence: float | None = None
    #: Which path produced this action, so the UI can show it honestly.
    planner: Literal["vlm", "rule-based"] = "rule-based"
    #: The model that decided, when one did — so each step names its weights.
    model: str | None = None
    #: Server-side timing, for the client's full latency breakdown.
    timings: dict[str, float] = Field(default_factory=dict)


class EgressIncident(BaseModel):
    """A PII hit found in an *inbound* payload. Type and path only, never a value."""

    type: str
    path: str
    rule: str | None = None


class RejectedResponse(BaseModel):
    detail: str
    incidents: list[EgressIncident]

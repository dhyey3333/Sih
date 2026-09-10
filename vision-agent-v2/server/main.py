"""
Server-side agent brain.

For the SIH demo, the server never sees unredacted pixels - only the
redacted screenshot (already layout-preserving-redacted + Set-of-Mark
labeled by the extension) plus a sanitized, VISION-DETECTED list of
interactable elements: mark number, tag (button/input/link/image),
confidence, and geometry - no DOM selectors, no field *values*, and no
DOM-level metadata like input "type" (email vs text vs tel), since the
extension no longer looks at the DOM to find these elements at all. That
last point is a real, deliberate trade-off of going fully vision-based:
the server can no longer tell "email field" from "name field" the way
the old DOM-selector version could, only "this is generically an input".

The server responds with a MARK NUMBER, never a selector or a pixel
coordinate - resolving a mark back to an actual on-page location is
background.js's job (it already has the vision model's box for that mark
in memory), keeping this server fully decoupled from any specific page's
DOM structure.

Two reasoning paths:
  - decide_next_action_rule_based(): zero-dependency, zero-API-key,
    always works - used as the guaranteed fallback and for fast local
    testing.
  - decide_next_action_vlm(): calls a real vision-language model
    (Anthropic's API here) on the redacted image, asking it to pick a
    numbered mark rather than guess coordinates.

decide_next_action() tries the VLM path first (if ANTHROPIC_API_KEY is
set) and transparently falls back to the rule-based path on any error -
so the demo NEVER breaks on stage even if the network or API key fails,
but genuinely uses real AI reasoning when available.
"""

import json
import os
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Vision Agent Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Interactable(BaseModel):
    mark: int  # number drawn on the redacted screenshot for this element
    tag: str  # "button" | "input" | "link" | "image" - from the VISION model's class, not a DOM tag name
    label: str | None = None  # always null for now - the vision model has no text/semantic understanding, only geometry+class
    sensitive: bool = False
    confidence: float | None = None  # the vision model's detection confidence for this box
    rect: dict | None = None


class AgentRequest(BaseModel):
    task: str
    redacted_image: str  # base64 data URL
    interactables: list[Interactable]
    redacted_region_count: int
    history: list[dict] = []


class AgentResponse(BaseModel):
    action: dict | None  # {"mark": int, "action": "click"|"type"|"scroll", "value": str|None} or None
    done: bool
    reasoning: str
    engine: str = "rule_based"  # "rule_based" or "vlm" - shown in the dashboard


GENERIC_FILL_VALUE = "Demo User"


def decide_next_action_rule_based(req: AgentRequest) -> AgentResponse:
    """
    Deterministic fallback: fills the first not-yet-acted, non-sensitive
    "input" box with a generic demo value, then clicks the first
    not-yet-acted "button" box once no fillable input remains. No network
    call, no API key, cannot fail - this is what keeps a live demo safe.

    NOTE: without DOM access, there's no "type" attribute to distinguish
    an email field from a name field from a phone field the way the old
    DOM-selector version could - every non-sensitive input gets the same
    generic value here. A real upgrade path (not yet built) is OCR'ing
    each input's placeholder/label text from the screenshot to pick a
    more appropriate fake value per field.
    """
    already_acted_marks = {h["action"]["mark"] for h in req.history if h.get("action")}

    for el in req.interactables:
        if el.mark in already_acted_marks:
            continue
        if el.tag == "input" and not el.sensitive:
            return AgentResponse(
                action={"action": "type", "mark": el.mark, "value": GENERIC_FILL_VALUE},
                done=False,
                reasoning=f"[rule-based] Filling non-sensitive input (mark {el.mark}); "
                f"{req.redacted_region_count} sensitive region(s) stayed redacted and untouched.",
                engine="rule_based",
            )

    for el in req.interactables:
        if el.mark in already_acted_marks:
            continue
        if el.tag == "button":
            return AgentResponse(
                action={"action": "click", "mark": el.mark},
                done=False,
                reasoning="[rule-based] All fillable non-sensitive inputs handled. Submitting the form.",
                engine="rule_based",
            )

    return AgentResponse(action=None, done=True, reasoning="[rule-based] No further actions available.", engine="rule_based")


VLM_SYSTEM_PROMPT = """You are a GUI agent. You are shown a screenshot where every \
clickable/fillable element DETECTED BY AN ON-DEVICE VISION MODEL has a numbered red \
mark drawn on it, and every sensitive field (passwords, card numbers, faces) is \
covered with a grey placeholder - you can never see their real content, by design.

Given the task and the list of interactable elements (with their mark numbers, tags, \
and detection confidence), decide the SINGLE next best action.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"mark": <int or null>, "action": "click" | "type" | "scroll" | null, "value": <string or null>, "done": <bool>, "reasoning": "<one sentence>"}

Rules:
- NEVER choose a mark whose element is marked sensitive:true - those are for the user to handle themselves.
- Use "type" only for non-sensitive "input"-tagged elements, with a short reasonable demo value.
- Use "click" for "button"-tagged elements.
- Tags come from a vision model, not page markup - there is no field "type" (email/text/etc) available, only tag + geometry + confidence.
- Set "done": true and "mark": null once the task appears complete or no safe action remains.
"""


def decide_next_action_vlm(req: AgentRequest) -> AgentResponse:
    """
    Real VLM call (Anthropic API). Sends the already-redacted screenshot -
    never raw pixels - plus the vision-detected interactable list, and
    asks the model to pick a mark number rather than guess pixel
    coordinates (Set-of-Mark grounding). The server never resolves marks
    to page locations itself - that stays entirely in background.js,
    which already holds the vision model's box for every mark.

    Raises on any failure (missing key, network error, bad response) so
    the caller (decide_next_action) can fall back to the rule-based path.
    """
    import anthropic  # imported lazily so the module still loads without the package installed

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    client = anthropic.Anthropic(api_key=api_key, timeout=15.0)

    header, b64data = req.redacted_image.split(",", 1) if "," in req.redacted_image else ("", req.redacted_image)
    media_type = "image/png"

    elements_summary = [
        {"mark": el.mark, "tag": el.tag, "confidence": el.confidence, "sensitive": el.sensitive}
        for el in req.interactables
    ]

    user_content = [
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64data}},
        {
            "type": "text",
            "text": f"Task: {req.task}\n\nVision-detected elements: {json.dumps(elements_summary)}\n\n"
            f"History so far: {json.dumps(req.history[-3:])}\n\nWhat is the single next action?",
        },
    ]

    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=300,
        system=VLM_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )

    text = "".join(block.text for block in response.content if block.type == "text")
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"VLM did not return parseable JSON: {text!r}")
    parsed = json.loads(match.group(0))

    if parsed.get("done") or parsed.get("mark") is None:
        return AgentResponse(action=None, done=True, reasoning=f"[vlm] {parsed.get('reasoning', '')}", engine="vlm")

    target_el = next((el for el in req.interactables if el.mark == parsed["mark"]), None)
    if target_el is None:
        raise ValueError(f"VLM chose mark {parsed['mark']} which doesn't exist")
    if target_el.sensitive:
        raise ValueError(f"VLM chose a sensitive mark ({parsed['mark']}) - refusing, treating as failure to trigger fallback")

    action = {"action": parsed["action"], "mark": parsed["mark"]}
    if parsed.get("value") is not None:
        action["value"] = parsed["value"]

    return AgentResponse(action=action, done=False, reasoning=f"[vlm] {parsed.get('reasoning', '')}", engine="vlm")


def decide_next_action(req: AgentRequest) -> AgentResponse:
    """Tries the real VLM path first, transparently falls back to the
    deterministic rule-based path on ANY failure - missing key, network
    issue, malformed response, or the model picking something unsafe. This
    means the demo is never one flaky API call away from breaking on
    stage."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            return decide_next_action_vlm(req)
        except Exception as exc:  # noqa: BLE001 - intentionally broad, this is a safety fallback
            print(f"[vision-agent] VLM path failed ({exc}); falling back to rule-based.")
    return decide_next_action_rule_based(req)


@app.post("/agent-action", response_model=AgentResponse)
async def agent_action(req: AgentRequest) -> AgentResponse:
    return decide_next_action(req)


@app.get("/health")
async def health():
    return {"status": "ok", "vlm_enabled": bool(os.environ.get("ANTHROPIC_API_KEY"))}

"""The deterministic planner.

Runs when no VLM endpoint is configured, and whenever the VLM call fails. It is
not a toy: it completes the form-filling demo on its own, which means the whole
pipeline — capture, redact, tokenize, guard, decide, rehydrate, execute — can be
demonstrated end to end with no API key, no GPU and no internet.

That matters twice over. It keeps `pytest` hermetic, and it means a dead venue
Wi-Fi degrades the demo rather than ending it. The response says which planner
produced it, so nobody can mistake this for the model reasoning.
"""

from __future__ import annotations

import re

from .schemas import StepRequest, StepResponse, WireElement

#: Which profile key can fill a field of each sensitive type.
#: Mirrors PROFILE_KEY_TYPE in extension/lib/pii/vault.ts.
_TYPE_TO_PROFILE_KEY = {
    "NAME": "FULL_NAME",
    "EMAIL": "EMAIL",
    "PHONE": "PHONE",
    "DOB": "DOB",
    "ADDRESS": "ADDRESS",
    "PINCODE": "PINCODE",
    "AADHAAR": "AADHAAR",
    "PAN": "PAN",
    "PASSPORT": "PASSPORT",
    "UPI": "UPI",
}

#: Button text that implies an irreversible action. Mirrors IRREVERSIBLE_HINTS
#: in protocol.ts — the client enforces this too; this just avoids wasting a step.
_IRREVERSIBLE = (
    "submit", "pay", "send", "delete", "remove", "confirm", "buy", "order",
    "transfer", "withdraw", "place order", "sign up", "register", "apply", "checkout",
)

_STOP_PHRASES = ("stop before", "don't submit", "do not submit", "without submitting")

#: Tasks that ask to be *told* something rather than to have something done.
#: Without this the form-filling path runs anyway and answers "Filled every field I
#: could" to the question "what is on this page", which is worse than declining.
#: A name field that is about someone else. Classified NAME — rightly, since it holds
#: a person's name and must be redacted — but filling it with the *applicant's* name
#: is wrong on almost every Indian government form, which asks for a father's,
#: mother's, guardian's or nominee's name as a matter of course.
_SOMEONE_ELSE = re.compile(
    r"\b(father|mother|guardian|spouse|husband|wife|nominee|parent|son|daughter|brother|sister|"
    r"relative|emergency contact|referee|witness|co-?applicant)\b|पिता|माता|पति|पत्नी|अभिभावक|नामांकित",
    re.IGNORECASE,
)

#: A task phrased as a question wants an answer, not a filled form.
_QUESTION = re.compile(
    r"^\s*(what|which|when|where|who|how much|how many|is|are|does|did|has|have|can you tell|tell me|check)\b",
    re.IGNORECASE,
)

_READ_ONLY_PHRASES = (
    "describe", "what is on", "what's on", "summarise", "summarize", "summary",
    "read this", "read the page", "tell me about", "explain this page", "what does this page",
)


def _is_editable(element: WireElement) -> bool:
    return element.role in {"textbox", "searchbox", "combobox"} and not element.disabled


def _here(request: StepRequest):
    """This page's history. Element ids are stable only within a page."""
    page = f"{request.page.origin}{request.page.path}"
    return [h for h in request.history if h.page is None or h.page == page]


def _is_empty(element: WireElement) -> bool:
    if element.filled is not None:
        return not element.filled
    return not element.value


def _looks_irreversible(element: WireElement) -> bool:
    label = f"{element.text or ''} {element.label or ''}".lower()
    return any(hint in label for hint in _IRREVERSIBLE)


def _repeated_failure(request: StepRequest, element_id: int) -> bool:
    """Two failures on the same element means stop trying it."""
    failures = [h for h in _here(request) if h.element_id == element_id and not h.ok]
    return len(failures) >= 2


#: A button whose only job is to show the next part of the form.
_ADVANCE = re.compile(
    r"^(next|next step|continue|proceed|save (and|&) continue|आगे|आगे बढ़ें)\s*[›>→»]*$",
    re.IGNORECASE,
)


def _already_clicked(request: StepRequest, element_id: int) -> bool:
    return any(h.element_id == element_id and h.action == "click" for h in _here(request))


def _already_answered(request: StepRequest, element_id: int) -> bool:
    return any(
        h.element_id == element_id and h.action in {"select", "type", "ask_user"} for h in _here(request)
    )


def _already_typed(request: StepRequest, element_id: int) -> bool:
    return any(
        h.element_id == element_id and h.ok and h.action == "type" for h in _here(request)
    )


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def describe(request: StepRequest) -> str:
    """A factual account of the screen, from the sanitized context alone.

    Not a model's reading of the page — a count of what the pipeline found, which is
    all this planner can honestly offer. It is still worth answering rather than
    refusing: it demonstrates that the *sanitized* context carries enough structure
    to be useful, which is the whole premise, and it names the redactions by type so
    the user can see what was withheld from this very description.
    """
    fields = [e for e in request.elements if _is_editable(e)]
    buttons = [e for e in request.elements if e.role == "button"]
    empty = [e for e in fields if _is_empty(e)]
    sensitive = [e for e in fields if e.sensitive]

    parts = [f"{request.page.origin}{request.page.path}"]
    if request.page.title:
        parts[0] += f" — {request.page.title}"

    if fields or buttons:
        shape = []
        if fields:
            shape.append(_plural(len(fields), "input"))
            if empty:
                shape.append(f"{len(empty)} of them empty")
        if buttons:
            shape.append(_plural(len(buttons), "button"))
        parts.append("The screen has " + ", ".join(shape) + ".")
    else:
        parts.append("No form controls are visible on this screen.")

    if sensitive:
        kinds = sorted({e.sensitive for e in sensitive if e.sensitive})
        verb = "asks" if len(sensitive) == 1 else "ask"
        parts.append(
            f"{_plural(len(sensitive), 'field')} {verb} for personal data: {', '.join(kinds)}."
        )

    if request.redactions:
        kinds = sorted({r.type for r in request.redactions})
        verb = "was" if len(request.redactions) == 1 else "were"
        parts.append(
            f"{_plural(len(request.redactions), 'region')} {verb} redacted before this "
            f"reached me: {', '.join(kinds)}. I cannot see any of those values."
        )
    else:
        parts.append("Nothing on this screen needed redacting.")

    named = [e.text for e in buttons if e.text][:4]
    if named:
        parts.append("Buttons: " + ", ".join(f"“{t}”" for t in named) + ".")

    return " ".join(parts)


def plan(request: StepRequest) -> StepResponse:
    """Decide the next action from the sanitized context alone."""
    available = set(request.profile_keys)

    # 0. A question, not an instruction. Answer it instead of filling the form —
    #    typing into someone's fields because they asked what the page says is the
    #    wrong action, not merely an unhelpful one.
    task = request.task.lower()
    is_question = task.strip().endswith("?") or bool(_QUESTION.match(task))
    if is_question or any(phrase in task for phrase in _READ_ONLY_PHRASES):
        return StepResponse(
            action="done",
            summary=describe(request),
            reason="The task asks for a description, so nothing needed to be clicked or typed.",
            confidence=0.9,
            planner="rule-based",
        )

    # 1. Fill any empty sensitive field we hold a profile value for.
    for element in request.elements:
        if not element.sensitive or not _is_editable(element):
            continue
        if element.sensitive == "PASSWORD":
            continue  # never typed by the agent
        if not _is_empty(element):
            continue
        if _repeated_failure(request, element.id) or _already_typed(request, element.id):
            continue

        key = _TYPE_TO_PROFILE_KEY.get(element.sensitive)
        if key == "FULL_NAME" and _SOMEONE_ELSE.search(element.label or element.placeholder or ""):
            continue  # someone else's name: ask (step 2), never guess with the user's own
        if key and key in available:
            return StepResponse(
                action="type",
                element_id=element.id,
                text=f"⟦PROFILE.{key}⟧",
                reason=f"'{element.label or element.id}' is an empty {element.sensitive} field "
                f"and the profile has {key}.",
                confidence=0.95,
                planner="rule-based",
            )

    # 2. A required field we cannot fill ourselves: ask rather than invent a value.
    for element in request.elements:
        if not element.required or not _is_editable(element) or not _is_empty(element):
            continue
        if _repeated_failure(request, element.id) or _already_typed(request, element.id):
            continue
        return StepResponse(
            action="ask_user",
            element_id=element.id,
            question=f"What should I put in '{element.label or f'field {element.id}'}'?",
            reason="Required field with no matching profile value.",
            confidence=0.8,
            planner="rule-based",
        )

    # 2b. A required radio group with nothing chosen — gender, category, "same as
    #     permanent address?". Asked as one question with the group's own options,
    #     because a radio button on its own is not something anyone can answer.
    asked_groups: set[str] = set()
    for element in request.elements:
        if element.role != "radio" or not element.group or element.group in asked_groups:
            continue
        group = [e for e in request.elements if e.role == "radio" and e.group == element.group]
        if not any(e.required for e in group) or any(e.checked for e in group):
            continue
        asked_groups.add(element.group)
        if any(_repeated_failure(request, e.id) or _already_answered(request, e.id) for e in group):
            continue
        choices = " / ".join(e.label for e in group if e.label)
        return StepResponse(
            action="ask_user",
            element_id=group[0].id,
            question=f"Which {element.group.replace('_', ' ')}? {choices}".strip(),
            reason="Required choice with no matching profile value.",
            confidence=0.8,
            planner="rule-based",
        )

    fill_task = not is_question and not any(phrase in task for phrase in _READ_ONLY_PHRASES)
    fillable_in_view = any(_is_editable(e) for e in request.elements)
    submit_in_view = any(e.role == "button" and _looks_irreversible(e) and not e.disabled for e in request.elements)

    # 2c. A wizard: this step is done, and the way on is a plain "Next". Not an
    #     irreversible button — those always go to the user — just the page's own
    #     way of showing the rest of the form.
    if fill_task:
        advance = next(
            (
                e for e in request.elements
                if e.role == "button" and not e.disabled and not _looks_irreversible(e)
                and _ADVANCE.match((e.text or e.label or "").strip())
                and not _already_clicked(request, e.id)
            ),
            None,
        )
        if advance is not None:
            return StepResponse(
                action="click",
                element_id=advance.id,
                reason=f"Every field on this step is handled; '{advance.text or advance.label}' shows the next.",
                confidence=0.85,
                planner="rule-based",
            )

    # 2d. Nothing to fill in view, no way to finish in view, and the page goes on:
    #     the form is further down. Bounded, so a page of endless feed cannot trap us.
    if fill_task and request.page.more_below and not fillable_in_view and not submit_in_view:
        if sum(1 for h in _here(request) if h.action == "scroll") < 4:
            return StepResponse(
                action="scroll",
                direction="down",
                reason="No form fields in view and the page continues below.",
                confidence=0.8,
                planner="rule-based",
            )

    # 3. Everything fillable is filled. Never press the irreversible button ourselves.
    stop_requested = any(phrase in request.task.lower() for phrase in _STOP_PHRASES)
    submit = next(
        (e for e in request.elements if e.role == "button" and _looks_irreversible(e) and not e.disabled),
        None,
    )

    if submit and not stop_requested:
        return StepResponse(
            action="ask_user",
            element_id=submit.id,
            question=f"Everything I can fill is filled. Press '{submit.text or submit.label}'?",
            reason="Irreversible action needs explicit confirmation.",
            confidence=0.9,
            planner="rule-based",
        )

    # No count here on purpose: the client sends only a recent window of history,
    # so any number we derive from it under-reports a long run. The client knows
    # the true total and shows it in the activity log.
    return StepResponse(
        action="done",
        summary=(
            "Filled every field I could from the local profile"
            + (", stopping before submit as asked." if stop_requested else ".")
        ),
        reason="Nothing left that can be done without the user.",
        confidence=0.9,
        planner="rule-based",
    )

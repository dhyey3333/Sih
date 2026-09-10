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


def _is_editable(element: WireElement) -> bool:
    return element.role in {"textbox", "searchbox", "combobox"} and not element.disabled


def _is_empty(element: WireElement) -> bool:
    if element.filled is not None:
        return not element.filled
    return not element.value


def _looks_irreversible(element: WireElement) -> bool:
    label = f"{element.text or ''} {element.label or ''}".lower()
    return any(hint in label for hint in _IRREVERSIBLE)


def _repeated_failure(request: StepRequest, element_id: int) -> bool:
    """Two failures on the same element means stop trying it."""
    failures = [h for h in request.history if h.element_id == element_id and not h.ok]
    return len(failures) >= 2


def _already_typed(request: StepRequest, element_id: int) -> bool:
    return any(
        h.element_id == element_id and h.ok and h.action == "type" for h in request.history
    )


def plan(request: StepRequest) -> StepResponse:
    """Decide the next action from the sanitized context alone."""
    available = set(request.profile_keys)

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

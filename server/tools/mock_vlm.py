"""A local OpenAI-compatible endpoint, for exercising the VLM path without weights.

    uv run uvicorn tools.mock_vlm:app --port 8100
    VLM_BASE_URL=http://localhost:8100/v1 VLM_MODEL=mock-vl \
        uv run uvicorn app.main:app --port 8000

**What this is, and what it is not.** It is not a model, and nothing measured
through it says anything about how well a model would choose. It is a *protocol
and prompt conformance harness*: it speaks the same wire format as vLLM, Ollama,
llama.cpp's server and every hosted open-weights endpoint, so the whole path —
build the prompt, POST it, parse the reply, validate it, execute it — runs for
real instead of being mocked out in a unit test.

Two properties it genuinely proves:

1. **The prompt carries enough to act on.** This file decides purely from the text
   of the user message. If `build_user_message` ever stopped emitting element ids,
   labels or `profile_keys`, this endpoint could not answer either, and the live
   test fails.
2. **A small model's messier output still works.** Real 7B-class models wrap JSON
   in prose and markdown fences far more often than large ones do, so that is what
   this returns. It is deliberately harder to parse than a well-behaved reply.

It also refuses to press anything irreversible, so the client's confirmation gate
is exercised by a *server that tried to do the right thing*, rather than only by a
deliberately hostile stub.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Mock open-weights VLM", version="1.0.0")

IRREVERSIBLE = re.compile(
    r"\b(submit|pay|send|delete|transfer|place order|confirm|remove|withdraw)\b", re.I
)

# Field label → profile key. Deliberately small and dumb: this stands in for a
# model's judgement, and pretending it is better than that would be dishonest.
LABEL_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bfull name|\bname\b", re.I), "FULL_NAME"),
    (re.compile(r"e-?mail", re.I), "EMAIL"),
    (re.compile(r"mobile|phone|contact number", re.I), "PHONE"),
    (re.compile(r"aadhaar|aadhar", re.I), "AADHAAR"),
    (re.compile(r"\bpan\b", re.I), "PAN"),
    (re.compile(r"date of birth|dob|birth", re.I), "DOB"),
    (re.compile(r"address|street", re.I), "ADDRESS"),
    (re.compile(r"pin ?code|postal", re.I), "PINCODE"),
    (re.compile(r"\bupi\b", re.I), "UPI"),
]


class ChatRequest(BaseModel):
    model: str
    messages: list[dict[str, Any]]
    temperature: float | None = None
    max_tokens: int | None = None
    response_format: dict[str, Any] | None = None


def _user_text(messages: list[dict[str, Any]]) -> str:
    """The text half of the user turn. The image, if any, is ignored — see above."""
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                part.get("text", "") for part in content if part.get("type") == "text"
            )
    return ""


_DECODER = json.JSONDecoder()


def _json_after(text: str, header: str) -> Any:
    """The first JSON value following `header`.

    Read with `raw_decode` rather than by slicing to the next section: the prompt's
    trailing instruction is prose, and the JSON itself contains blank lines and
    brackets, so any delimiter-based split is one prompt edit away from breaking.
    """
    start = text.find(header)
    if start == -1:
        return None
    start = text.find("[", start + len(header))
    if start == -1:
        return None
    try:
        value, _ = _DECODER.raw_decode(text, start)
    except json.JSONDecodeError:
        return None
    return value


def _elements(text: str) -> list[dict[str, Any]]:
    value = _json_after(text, "ELEMENTS:")
    return value if isinstance(value, list) else []


def _profile_keys(text: str) -> set[str]:
    match = re.search(r"PROFILE KEYS AVAILABLE:(.*)", text)
    if not match:
        return set()
    return {k.strip() for k in match.group(1).split(",") if k.strip() and k.strip() != "(none)"}


def _already_typed(text: str) -> set[int]:
    """Element ids the HISTORY says were acted on, so we do not loop."""
    history = _json_after(text, "HISTORY")
    if not isinstance(history, list):
        return set()
    return {
        entry["element_id"]
        for entry in history
        if isinstance(entry, dict) and isinstance(entry.get("element_id"), int)
    }


def _decide(text: str) -> dict[str, Any]:
    elements = _elements(text)
    keys = _profile_keys(text)
    done = _already_typed(text)

    for element in elements:
        if element.get("id") in done:
            continue
        if element.get("role") != "textbox" or element.get("disabled"):
            continue
        if element.get("value") or element.get("filled"):
            continue
        # A password field carries no token and must never be typed into.
        if element.get("sensitive") == "PASSWORD":
            continue

        haystack = " ".join(
            str(element.get(field, "")) for field in ("label", "placeholder", "name", "text")
        )
        for pattern, key in LABEL_HINTS:
            if key in keys and pattern.search(haystack):
                return {
                    "action": "type",
                    "element_id": element["id"],
                    "text": f"⟦PROFILE.{key}⟧",
                    "reason": f"field {element['id']} looks like {key.lower().replace('_', ' ')}",
                }

    # Nothing left to fill. If a submit-like control is present, hand the decision
    # back to the person rather than pressing it.
    for element in elements:
        label = str(element.get("text") or element.get("label") or "")
        if element.get("role") == "button" and IRREVERSIBLE.search(label):
            return {
                "action": "ask_user",
                "question": f"Everything is filled. Press “{label.strip()}”?",
                "reason": "the remaining control is irreversible",
            }

    return {"action": "done", "summary": "Nothing further to fill on this screen.", "reason": "no empty fields left"}


def _reply_text(action: dict[str, Any]) -> str:
    """Wrap the action the way a small open-weights model usually does."""
    return (
        "Looking at the elements list, the next useful step is clear.\n\n"
        "```json\n" + json.dumps(action, ensure_ascii=False) + "\n```"
    )


@app.get("/v1/models")
async def models() -> dict:
    return {"object": "list", "data": [{"id": "mock-vl", "object": "model"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest) -> dict:
    text = _user_text(request.messages)
    content = _reply_text(_decide(text))
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": request.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": len(text) // 4, "completion_tokens": len(content) // 4},
    }

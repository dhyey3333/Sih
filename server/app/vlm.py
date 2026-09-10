"""Provider-agnostic VLM client.

A plain POST to ``{VLM_BASE_URL}/chat/completions`` in OpenAI's shape, which is
what vLLM, Ollama, llama.cpp's server, OpenRouter, Together, Groq and most hosted
open-weights endpoints all speak. Swapping providers is an env var, not a code
change — the problem statement calls for any offline-deployable open-weights model,
so nothing here may assume a particular vendor.

Deliberately no ``openai`` SDK: forty lines of httpx keeps the dependency list
short and the retry/validation behaviour ours (docs/DECISIONS.md D10).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

import httpx

from .prompt import SYSTEM_PROMPT, build_user_message
from .schemas import StepRequest, StepResponse


class VLMError(RuntimeError):
    """Any failure talking to the model. Always caught: we fall back to the planner."""


@dataclass(frozen=True)
class VLMConfig:
    base_url: str
    model: str
    api_key: str
    timeout: float

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)


def load_config() -> VLMConfig:
    return VLMConfig(
        base_url=os.getenv("VLM_BASE_URL", "").rstrip("/"),
        model=os.getenv("VLM_MODEL", ""),
        api_key=os.getenv("VLM_API_KEY", ""),
        timeout=float(os.getenv("VLM_TIMEOUT", "45")),
    )


def _build_messages(request: StepRequest) -> list[dict]:
    content: list[dict] = [{"type": "text", "text": build_user_message(request)}]

    # Only at disclosure level 2, and it is the *redacted* JPEG — the extension
    # never produces an unredacted one for the wire.
    if request.screen is not None:
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{request.screen.image_jpeg_b64}"
                },
            }
        )

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def parse_action(raw: str) -> dict:
    """Pull one JSON action object out of a model response.

    Small open-weights models wrap JSON in prose or a markdown fence far more often
    than large ones do, and a strict parser turns that into a fallback that the
    demo did not need. Try the strict read first, then a fence, then the first
    balanced object in the text.
    """
    text = raw.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    fenced = _FENCE_RE.search(text)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass

    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)

    raise VLMError("Model response contained no JSON object")


async def decide(request: StepRequest, config: VLMConfig) -> StepResponse:
    """Ask the VLM for one action. Raises VLMError; the caller falls back."""
    if not config.configured:
        raise VLMError("No VLM endpoint configured")

    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"

    body = {
        "model": config.model,
        "messages": _build_messages(request),
        # Deterministic-ish: this is a control decision, not creative writing.
        "temperature": 0.1,
        "max_tokens": 400,
        # Honoured by vLLM/OpenAI-compatible servers that support it; harmlessly
        # ignored by those that don't, which is why parse_action stays tolerant.
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=config.timeout) as client:
            response = await client.post(
                f"{config.base_url}/chat/completions", json=body, headers=headers
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPStatusError as exc:
        raise VLMError(f"VLM returned {exc.response.status_code}") from exc
    except httpx.HTTPError as exc:
        raise VLMError(f"VLM request failed: {type(exc).__name__}") from exc

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise VLMError("VLM response had an unexpected shape") from exc

    action = parse_action(content if isinstance(content, str) else json.dumps(content))
    action.pop("planner", None)
    action.pop("timings", None)

    try:
        return StepResponse(**action, planner="vlm")
    except Exception as exc:  # pydantic validation
        raise VLMError(f"VLM action failed validation: {type(exc).__name__}") from exc

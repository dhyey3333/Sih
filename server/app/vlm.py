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
    #: Room for the answer. 400 was enough for a plain instruct model and nowhere
    #: near enough for a "thinking" one, which spends its whole budget reasoning and
    #: returns an empty answer — the failure mode that made a real model look broken.
    max_tokens: int = 1024
    #: Ask for JSON mode. Some providers reject it for some models (HTTP 400); the
    #: client then retries once without it rather than failing the step.
    json_mode: bool = True
    #: Provider-specific switches, merged into the request body as-is — e.g.
    #: ``{"reasoning": {"enabled": false}}`` (OpenRouter) or
    #: ``{"chat_template_kwargs": {"enable_thinking": false}}`` (vLLM, SGLang).
    extra_body: dict | None = None

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)


def _extra_body_from_env() -> dict | None:
    raw = os.getenv("VLM_EXTRA_BODY", "").strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"VLM_EXTRA_BODY is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit("VLM_EXTRA_BODY must be a JSON object")
    return value


def load_config() -> VLMConfig:
    return VLMConfig(
        base_url=os.getenv("VLM_BASE_URL", "").rstrip("/"),
        model=os.getenv("VLM_MODEL", ""),
        api_key=os.getenv("VLM_API_KEY", ""),
        timeout=float(os.getenv("VLM_TIMEOUT", "30")),
        max_tokens=int(os.getenv("VLM_MAX_TOKENS", "1024")),
        json_mode=os.getenv("VLM_JSON_MODE", "1").lower() not in {"0", "false", "no"},
        extra_body=_extra_body_from_env(),
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


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def answer_text(message: dict) -> str:
    """The model's answer, with any visible reasoning removed.

    Reasoning models return their thinking in three different ways depending on the
    server: inline as ``<think>…</think>``, in a separate ``reasoning_content`` /
    ``reasoning`` field, or — when the token budget ran out mid-thought — as an
    unterminated ``<think>`` with no answer after it. The answer is what is left
    once the reasoning is taken out; if nothing is left, the reasoning itself is
    searched for a JSON action, because some servers put the final object there.
    """
    content = message.get("content")
    if isinstance(content, list):  # content parts
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    text = _THINK_RE.sub("", content or "").strip()
    if "<think>" in text.lower():  # unterminated: the budget ran out while thinking
        text = text[: text.lower().index("<think>")].strip()
    if text:
        return text
    for field in ("reasoning_content", "reasoning"):
        extra = message.get(field)
        if isinstance(extra, str) and "{" in extra:
            return extra
    return ""


async def decide(request: StepRequest, config: VLMConfig) -> StepResponse:
    """Ask the VLM for one action. Raises VLMError; the caller falls back."""
    if not config.configured:
        raise VLMError("No VLM endpoint configured")

    headers = {"Content-Type": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"

    body: dict = {
        "model": config.model,
        "messages": _build_messages(request),
        # Deterministic-ish: this is a control decision, not creative writing.
        "temperature": 0.1,
        "max_tokens": config.max_tokens,
    }
    if config.json_mode:
        body["response_format"] = {"type": "json_object"}
    if config.extra_body:
        body.update(config.extra_body)

    payload = await _post(config, body, headers)

    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise VLMError("VLM response had an unexpected shape") from exc

    text = answer_text(message)
    if not text:
        finish = (payload["choices"][0] or {}).get("finish_reason")
        raise VLMError(
            "VLM returned an empty answer"
            + (" (ran out of tokens — raise VLM_MAX_TOKENS or disable thinking)" if finish == "length" else "")
        )

    action = parse_action(text)
    action.pop("planner", None)
    action.pop("timings", None)
    action.pop("model", None)

    try:
        return StepResponse(**action, planner="vlm", model=config.model)
    except Exception as exc:  # pydantic validation
        raise VLMError(f"VLM action failed validation: {type(exc).__name__}") from exc


async def _post(config: VLMConfig, body: dict, headers: dict) -> dict:
    """POST, retrying once without JSON mode if the provider rejects it."""
    try:
        async with httpx.AsyncClient(timeout=config.timeout) as client:
            response = await client.post(f"{config.base_url}/chat/completions", json=body, headers=headers)
            if response.status_code == 400 and "response_format" in body:
                retry = {k: v for k, v in body.items() if k != "response_format"}
                response = await client.post(f"{config.base_url}/chat/completions", json=retry, headers=headers)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        raise VLMError(f"VLM returned {exc.response.status_code}") from exc
    except httpx.TimeoutException as exc:
        raise VLMError(f"VLM timed out after {config.timeout:.0f} s") from exc
    except httpx.HTTPError as exc:
        raise VLMError(f"VLM request failed: {type(exc).__name__}") from exc

"""FastAPI app.

One endpoint that matters: ``POST /v1/step``. It takes the sanitized context the
extension produced and returns exactly one UI action.

Order of operations, and the first one is not optional:
  1. Re-scan the inbound payload for raw PII. Reject on any hit.
  2. Ask the VLM.
  3. On any VLM failure, fall back to the deterministic planner.
  4. Return timings so the client can show a full latency breakdown.

Step 1 exists because a bug in the client must not be able to leak PII onwards to
a third-party model. The server refuses rather than forwards.
"""

from __future__ import annotations

import hmac
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import egress, view
from .planner import plan, search_query
from .schemas import RejectedResponse, StepRequest, StepResponse
from .vlm import VLMConfig, VLMError, decide, load_config, needs_image

logger = logging.getLogger("privagent")

_config: VLMConfig = load_config()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _config
    _config = load_config()
    if _config.configured:
        logger.info("VLM: %s at %s", _config.model, _config.base_url)
    else:
        logger.info("VLM: not configured — using the deterministic planner")
    yield


app = FastAPI(
    title="PrivAgent server",
    version="0.1.0",
    description="Receives sanitized, tokenized page context and returns one UI action.",
    lifespan=lifespan,
)

#: Optional shared secret. Set it on any planner that is reachable from more than
#: localhost; the side panel sends it as a bearer token.
PLANNER_TOKEN = os.getenv("PLANNER_TOKEN", "")

#: A step is a redacted JPEG plus JSON: a few hundred KB. Anything near this is not
#: a step, and is refused before it is parsed.
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", str(8 * 1024 * 1024)))

#: Per client address. An agent takes about one step a second; this leaves room for
#: several panels and none for a loop hammering a paid model endpoint.
RATE_PER_SECOND = float(os.getenv("RATE_LIMIT_PER_SECOND", "5"))
RATE_BURST = float(os.getenv("RATE_LIMIT_BURST", "20"))
_buckets: dict[str, tuple[float, float]] = {}


def _allow(client: str) -> bool:
    """Token bucket: RATE_BURST steps at once, refilled at RATE_PER_SECOND."""
    now = time.monotonic()
    tokens, last = _buckets.get(client, (RATE_BURST, now))
    tokens = min(RATE_BURST, tokens + (now - last) * RATE_PER_SECOND)
    if tokens < 1:
        _buckets[client] = (tokens, now)
        return False
    _buckets[client] = (tokens - 1, now)
    return True


@app.middleware("http")
async def guard_the_door(request: Request, call_next):
    if request.url.path.startswith("/v1/"):
        if PLANNER_TOKEN and request.method != "OPTIONS":
            supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
            if not hmac.compare_digest(supplied.encode(), PLANNER_TOKEN.encode()):
                return JSONResponse(status_code=401, content={"detail": "Missing or wrong access token."})
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request too large to be a step."})
        if request.method == "POST" and not _allow(request.client.host if request.client else "?"):
            return JSONResponse(status_code=429, content={"detail": "Too many steps; slow down."})
    return await call_next(request)


# Who may call from a browser. The extension's origin is <scheme>-extension://<id>,
# and the id differs per install, so the default is any extension origin — which
# still keeps an arbitrary web page from using a running planner as a free relay to
# the model. ALLOWED_ORIGINS (comma-separated, or "*") overrides it. CORS is not
# authentication — anything outside a browser ignores it; PLANNER_TOKEN is that.
#
# Added after the guard so that it wraps it: a 401 or 429 must carry CORS headers,
# or the browser hides it and the panel reports "cannot reach the planner" instead.
_EXTENSION_ORIGIN = r"^(chrome-extension|moz-extension|safari-web-extension)://[A-Za-z0-9._-]+$"
_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=None if _origins else _EXTENSION_ORIGIN,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)


app.include_router(view.router)


#: How the VLM and the rules share the work.
#:   vlm-first    the model decides every step; rules only when it fails (default)
#:   rules-first  rules take the steps they are certain of — an empty field the
#:                profile can fill — and the model takes every judgement call
#: rules-first is the fast mode for a small local model: form bookkeeping costs no
#: inference, and the model is spent where reasoning actually happens.
STRATEGY = os.getenv("VLM_STRATEGY", "vlm-first").strip().lower()


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "vlm_configured": _config.configured,
        "vlm_model": _config.model or None,
        "planner": "vlm" if _config.configured else "rule-based",
        "strategy": STRATEGY if _config.configured else None,
        "image": _config.image if _config.configured else None,
        "auth_required": bool(PLANNER_TOKEN),
    }


@app.post(
    "/v1/step",
    response_model=StepResponse,
    responses={422: {"model": RejectedResponse, "description": "Raw PII detected in the payload"}},
)
async def step(request: StepRequest, http_request: Request) -> JSONResponse:
    started = time.perf_counter()
    timings: dict[str, float] = {}

    # 1. Guard. Runs on the parsed payload, so it sees exactly what we would forward.
    guard_start = time.perf_counter()
    incidents = egress.scan_payload(request.model_dump(exclude_none=True))
    timings["guard"] = _ms(guard_start)

    if incidents:
        # Log the summary only — types and paths, never values.
        logger.warning(
            "Rejected step for session %s: %s", request.session_id, egress.describe(incidents)
        )
        view.record_rejection(request, incidents)
        return JSONResponse(
            status_code=422,  # Unprocessable Content
            content=RejectedResponse(
                detail=(
                    "Payload contained unredacted PII and was rejected. "
                    "The client-side sanitizer should have caught this."
                ),
                incidents=incidents,
            ).model_dump(),
        )

    # 2 & 3. VLM, with the deterministic planner as the guaranteed fallback.
    inference_start = time.perf_counter()
    fallback_reason: str | None = None

    if _config.configured:
        certain = plan(request) if STRATEGY == "rules-first" else None
        # What the rules are sure of: typing a profile value into a field of its
        # type, a value the task itself states, and running a search the task
        # spelled out. Every judgement call — a question, a choice nobody stated,
        # whether the task is finished — goes to the model.
        searched = search_query(request.task) is not None
        if certain is not None and (
            certain.action in {"type", "select"}
            or (certain.action == "key" and searched)
            # The search the task spelled out has run: finishing is not a judgement call.
            # Handing it to a small model anyway let a page's note to "AI assistants"
            # keep it busy until the step budget ran out.
            or (certain.action == "done" and searched and any(h.action == "key" and h.ok for h in request.history))
        ):
            response = certain
        else:
            try:
                timings["image_sent"] = float(
                    request.screen is not None
                    and (_config.image == "always" or (_config.image == "auto" and needs_image(request)))
                )
                response = await decide(request, _config)
            except VLMError as exc:
                fallback_reason = str(exc)
                logger.warning("VLM unavailable, falling back: %s", fallback_reason)
                response = certain or plan(request)
    else:
        response = plan(request)

    timings["inference"] = _ms(inference_start)
    timings["server_total"] = _ms(started)
    response.timings = {**(response.timings or {}), **timings}

    if fallback_reason and response.reason:
        response.reason = f"{response.reason} (VLM unavailable: {fallback_reason})"

    view.record_step(request, response)

    return JSONResponse(content=response.model_dump(exclude_none=True))


def _ms(since: float) -> float:
    return round((time.perf_counter() - since) * 1000, 1)

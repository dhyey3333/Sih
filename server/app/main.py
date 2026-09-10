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

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import egress
from .planner import plan
from .schemas import RejectedResponse, StepRequest, StepResponse
from .vlm import VLMConfig, VLMError, decide, load_config

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

# The extension's origin is chrome-extension://<id>, which differs per install, so
# a local dev server has little choice but to allow all. Tighten for deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "vlm_configured": _config.configured,
        "vlm_model": _config.model or None,
        "planner": "vlm" if _config.configured else "rule-based",
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
        try:
            response = await decide(request, _config)
        except VLMError as exc:
            fallback_reason = str(exc)
            logger.warning("VLM unavailable, falling back: %s", fallback_reason)
            response = plan(request)
    else:
        response = plan(request)

    timings["inference"] = _ms(inference_start)
    timings["server_total"] = _ms(started)
    response.timings = timings

    if fallback_reason and response.reason:
        response.reason = f"{response.reason} (VLM unavailable: {fallback_reason})"

    return JSONResponse(content=response.model_dump(exclude_none=True))


def _ms(since: float) -> float:
    return round((time.perf_counter() - since) * 1000, 1)

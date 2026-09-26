"""What the server sees — a live page of every step the planner receives.

The privacy claim is about the far side of the wire, and that is the side nobody in
a demo can see. This page shows it: each step as it arrives, the redacted screenshot,
the tokens, the screen text, and the action decided. Put it on a second screen beside
the browser and the audience watches both sides of the boundary at once.

Off unless PLANNER_VIEW=1. When on, it keeps the last few steps in memory only —
nothing is written anywhere — and it holds nothing the planner did not already hold:
every item here passed the client's egress guard and this server's own scan. A
rejected payload is shown as its incident (types and paths, never values), which is
the server-side guard at work.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from .schemas import EgressIncident, StepRequest, StepResponse

ENABLED = os.getenv("PLANNER_VIEW", "").strip().lower() in {"1", "true", "yes", "on"}
KEEP = 20

_recent: deque[dict[str, Any]] = deque(maxlen=KEEP)
_listeners: set[asyncio.Queue] = set()
_PAGE = (Path(__file__).parent / "view.html").read_text(encoding="utf-8")

router = APIRouter()


def _publish(item: dict[str, Any]) -> None:
    _recent.append(item)
    for queue in list(_listeners):
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:  # a stalled tab loses steps, never blocks the planner
            pass


def record_step(request: StepRequest, response: StepResponse) -> None:
    if not ENABLED:
        return
    _publish({
        "kind": "step",
        "at": time.time(),
        "task": request.task,
        "step": request.step,
        "page": f"{request.page.origin}{request.page.path}",
        "title": request.page.title,
        "disclosure": request.disclosure_level,
        "image": request.screen.image_jpeg_b64 if request.screen else None,
        "redactions": [{"token": r.token, "type": r.type, "source": r.source} for r in request.redactions],
        "elements": len(request.elements),
        "screen_text": request.visible_text,
        "profile_keys": request.profile_keys,
        "action": response.model_dump(exclude_none=True, exclude={"timings"}),
        "timings": response.timings or {},
    })


def record_rejection(request: StepRequest, incidents: list[EgressIncident]) -> None:
    if not ENABLED:
        return
    _publish({
        "kind": "rejected",
        "at": time.time(),
        "task": "",  # the task may be where the PII was; show nothing from this payload
        "page": "",
        "incidents": [{"type": i.type, "path": i.path} for i in incidents],
    })


def _disabled() -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": "Start the server with PLANNER_VIEW=1 to enable this page."})


@router.get("/view", response_class=HTMLResponse)
async def view_page():
    return HTMLResponse(_PAGE) if ENABLED else _disabled()


@router.get("/view/recent")
async def view_recent():
    return list(_recent) if ENABLED else _disabled()


@router.get("/view/events")
async def view_events():
    if not ENABLED:
        return _disabled()
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    _listeners.add(queue)

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"  # proxies drop a silent stream
        finally:
            _listeners.discard(queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store"})

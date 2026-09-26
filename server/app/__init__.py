"""PrivAgent server-side agent brain."""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env_file(path: Path = ENV_FILE) -> None:
    """Read server/.env, if there is one — the file the README tells you to use.

    Settings are read at import time throughout (VLM_STRATEGY, PLANNER_TOKEN, …), so
    this runs from the package's own import, before any of them. A variable already
    in the environment wins: a value on the command line is never overridden by the
    file. Plain KEY=value lines, # comments, optional quotes — no dependency needed.
    """
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


load_env_file()

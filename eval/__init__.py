"""Metric harnesses: `run_all` (detection and redaction), `run_tasks` (the agent end to
end), `smoke_extension` (the packed build boots).

Every tool here prints task names in Hindi, arrows and quotation marks. On Windows,
Python writes redirected output in the console's legacy code page (cp1252), where
those characters do not exist and the first `print` of one ends the run. UTF-8 for
both streams, set once on import, keeps the same commands working on every machine.
"""

import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

from __future__ import annotations

import os
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TextIO


DEFAULT_MODEL_LOG_DIR = "/app/frontend/.runtime_logs"
FALLBACK_MODEL_LOG_DIR = "/tmp/avsp-model-logs"


class _TeeTextStream:
    def __init__(self, original: TextIO, mirror: TextIO) -> None:
        self._original = original
        self._mirror = mirror
        self._lock = threading.Lock()
        self.encoding = getattr(original, "encoding", "utf-8")
        self.errors = getattr(original, "errors", "replace")

    def write(self, data: str) -> int:
        text = str(data)
        with self._lock:
            self._original.write(text)
            self._original.flush()
            self._mirror.write(text)
            self._mirror.flush()
        return len(text)

    def flush(self) -> None:
        with self._lock:
            self._original.flush()
            self._mirror.flush()

    def isatty(self) -> bool:
        return bool(getattr(self._original, "isatty", lambda: False)())

    def fileno(self) -> int:
        return int(getattr(self._original, "fileno", lambda: -1)())

    def writable(self) -> bool:
        return True


@dataclass(frozen=True)
class StartupLogHandle:
    worker: str
    path: str


def setup_worker_startup_logging(worker: str) -> StartupLogHandle:
    worker_name = str(worker).strip().lower()
    if worker_name not in {"embedder", "vlm"}:
        raise ValueError(f"Unsupported worker for startup logs: {worker_name!r}")

    configured_log_dir = str(os.getenv("MODEL_STARTUP_LOG_DIR", DEFAULT_MODEL_LOG_DIR)).strip()
    log_dir = configured_log_dir or DEFAULT_MODEL_LOG_DIR
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError:
        log_dir = FALLBACK_MODEL_LOG_DIR
        os.makedirs(log_dir, exist_ok=True)

    log_path = os.path.join(log_dir, f"{worker_name}.log")
    started_at = datetime.now(timezone.utc).isoformat()
    with open(log_path, "w", encoding="utf-8") as fp:
        fp.write(f"=== {worker_name} startup {started_at} ===\n")
        fp.flush()

    mirror = open(log_path, "a", encoding="utf-8", buffering=1)

    if not isinstance(sys.stdout, _TeeTextStream):
        sys.stdout = _TeeTextStream(sys.stdout, mirror)
    if not isinstance(sys.stderr, _TeeTextStream):
        sys.stderr = _TeeTextStream(sys.stderr, mirror)

    return StartupLogHandle(worker=worker_name, path=log_path)

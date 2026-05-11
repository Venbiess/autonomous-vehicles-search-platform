import os
import re
import subprocess
import threading
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import HTTPException


WAYMO_AUTH_MAX_LOG_LINES = 300
waymo_auth_lock = threading.Lock()
waymo_auth_session: Dict[str, Any] = {
    "session_id": None,
    "process": None,
    "thread": None,
    "auth_url": None,
    "awaiting_code": False,
    "logs": [],
    "started_at": 0.0,
    "finished": False,
    "returncode": None,
}


def extract_first_url(line: str) -> Optional[str]:
    match = re.search(r"https://[^\s]+", line)
    if not match:
        return None
    return match.group(0).rstrip(").,")


def is_process_alive_locked() -> bool:
    proc = waymo_auth_session.get("process")
    return bool(proc is not None and proc.poll() is None)


def append_log_locked(line: str) -> None:
    logs = waymo_auth_session.get("logs")
    if not isinstance(logs, list):
        logs = []
        waymo_auth_session["logs"] = logs
    logs.append(line)
    if len(logs) > WAYMO_AUTH_MAX_LOG_LINES:
        del logs[: len(logs) - WAYMO_AUTH_MAX_LOG_LINES]


def auth_reader(session_id: str, proc: subprocess.Popen) -> None:
    stream = proc.stdout
    if stream is None:
        return

    for raw_line in stream:
        line = str(raw_line).rstrip("\n")
        with waymo_auth_lock:
            if waymo_auth_session.get("session_id") != session_id:
                continue
            append_log_locked(line)
            auth_url = waymo_auth_session.get("auth_url")
            if not auth_url and "https://" in line:
                maybe_url = extract_first_url(line)
                if maybe_url and "google" in maybe_url:
                    waymo_auth_session["auth_url"] = maybe_url
            lowered = line.lower()
            if "enter authorization code" in lowered:
                waymo_auth_session["awaiting_code"] = True

    return_code = proc.poll()
    with waymo_auth_lock:
        if waymo_auth_session.get("session_id") == session_id:
            waymo_auth_session["finished"] = True
            waymo_auth_session["returncode"] = int(return_code) if return_code is not None else None


def start_session() -> Dict[str, Any]:
    command = [
        "gcloud",
        "auth",
        "application-default",
        "login",
        "--no-launch-browser",
    ]
    env = dict(os.environ)
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "0"
    try:
        proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail="gcloud is not available in avsp-server container",
        ) from exc

    session_id = str(uuid.uuid4())
    reader = threading.Thread(
        target=auth_reader,
        args=(session_id, proc),
        name=f"waymo-auth-{session_id[:8]}",
        daemon=True,
    )
    with waymo_auth_lock:
        waymo_auth_session.update(
            {
                "session_id": session_id,
                "process": proc,
                "thread": reader,
                "auth_url": None,
                "awaiting_code": False,
                "logs": [],
                "started_at": time.time(),
                "finished": False,
                "returncode": None,
            }
        )
    reader.start()
    return {"session_id": session_id}


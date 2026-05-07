from __future__ import annotations

import os
import time
from dataclasses import dataclass

import pytest
import requests


@dataclass(frozen=True)
class TestSettings:
    storage_base_url: str
    write_token: str
    bucket: str
    request_timeout_sec: int


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip() or default


@pytest.fixture(scope="session")
def settings() -> TestSettings:
    return TestSettings(
        storage_base_url=_env("STORAGE_BASE_URL", "http://localhost:9012").rstrip("/"),
        write_token=_env("STORAGE_WRITE_TOKEN", "change-me-storage-write-token"),
        bucket=_env("STORAGE_TEST_BUCKET", "avsp"),
        request_timeout_sec=int(_env("STORAGE_TEST_TIMEOUT_SEC", "20")),
    )


@pytest.fixture(scope="session")
def http_session() -> requests.Session:
    session = requests.Session()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(scope="session", autouse=True)
def wait_for_storage_ready(settings: TestSettings, http_session: requests.Session) -> None:
    deadline = time.time() + 60
    last_error = ""
    while time.time() < deadline:
        try:
            response = http_session.get(
                f"{settings.storage_base_url}/health",
                timeout=settings.request_timeout_sec,
            )
            if response.status_code == 200:
                return
            last_error = f"status={response.status_code} body={response.text[:300]}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(1)
    pytest.fail(f"storage server is not ready: {last_error}")

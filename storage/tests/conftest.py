from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass

import boto3
import pytest
import requests
from botocore.client import Config


@dataclass(frozen=True)
class TestSettings:
    storage_base_url: str
    write_token: str
    minio_endpoint_url: str
    minio_access_key: str
    minio_secret_key: str
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
        minio_endpoint_url=_env("MINIO_ENDPOINT_URL", "http://localhost:9002"),
        minio_access_key=_env("S3_ACCESS_KEY_ID", "minioadmin"),
        minio_secret_key=_env("S3_SECRET_ACCESS_KEY", "minioadmin"),
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
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        time.sleep(1)
    pytest.fail(f"storage server is not ready: {last_error}")


@pytest.fixture(scope="session")
def s3_client(settings: TestSettings):
    return boto3.client(
        "s3",
        endpoint_url=settings.minio_endpoint_url,
        aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key,
        region_name="us-east-1",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    )


@pytest.fixture()
def uploaded_object(settings: TestSettings, s3_client):
    key = f"integration/{uuid.uuid4().hex}.jpg"
    payload = (
        b"\xff\xd8\xff\xe0"
        + b"AVSP-INTEGRATION-TEST"
        + uuid.uuid4().hex.encode("ascii")
        + b"\xff\xd9"
    )
    s3_client.put_object(
        Bucket=settings.bucket,
        Key=key,
        Body=payload,
        ContentType="image/jpeg",
    )
    return {
        "bucket": settings.bucket,
        "key": key,
        "bytes": payload,
        "storage_path": f"s3://{settings.bucket}/{key}",
        "storage_path_short": f"{settings.bucket}/{key}",
    }

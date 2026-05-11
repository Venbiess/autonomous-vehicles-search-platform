import logging
import threading
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI

from backend.server.analytics_api import AnalyticsAPI
from backend.server.model_bus import ModelGateway
from backend.server.storage_api import StorageAPI
from configs.common import (
    ANALYTICS_SERVER_ENDPOINT,
    ANALYTICS_SERVER_TIMEOUT_SEC,
    STORAGE_SERVER_ENDPOINT,
    STORAGE_SERVER_TIMEOUT_SEC,
    STORAGE_WRITE_TOKEN,
)


logger = logging.getLogger("avsp.master")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AVSP Master Server")

jobs_store: Dict[str, Dict[str, Any]] = {}
jobs_lock = threading.Lock()
JOB_LOG_DIR = Path("/tmp/avsp-job-logs")
JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
JOBS_JOB_LOG_TAIL_LINES = 200

storage_api = StorageAPI(
    endpoint=STORAGE_SERVER_ENDPOINT,
    timeout_sec=STORAGE_SERVER_TIMEOUT_SEC,
    write_token=STORAGE_WRITE_TOKEN,
)
analytics_api = AnalyticsAPI(
    endpoint=ANALYTICS_SERVER_ENDPOINT,
    timeout_sec=ANALYTICS_SERVER_TIMEOUT_SEC,
    write_token=STORAGE_WRITE_TOKEN,
)
model_gateway = ModelGateway()


from __future__ import annotations

import argparse
import base64
import glob
import io
import json
import logging
import os
import socket
import traceback
import threading
import time
from typing import Any
from typing import Dict
from pathlib import Path

import pika
import uvicorn
from PIL import Image

from backend.models.common.startup_logs import setup_worker_startup_logging
from backend.observability.worker_metrics import observe_job
from backend.observability.worker_metrics import start_metrics_server

logger = logging.getLogger("avsp.model-worker")
logging.basicConfig(level=logging.INFO)


class _HealthcheckAccessFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return "/health" not in message


def _suppress_healthcheck_access_logs() -> None:
    access_logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, _HealthcheckAccessFilter) for item in access_logger.filters):
        access_logger.addFilter(_HealthcheckAccessFilter())


def _prepare_cuda_library_path() -> None:
    """
    Ensure CUDA/NVIDIA wheel libraries are resolvable by dynamic loader.
    Some torch builds expect libnvrtc-builtins from package-specific folders.
    """

    base = Path("/usr/local/lib/python3.10/site-packages/nvidia")
    discovered: list[str] = []
    if base.exists():
        preferred = (
            "cuda_runtime",
            "cuda_nvrtc",
            "cublas",
            "cudnn",
            "cusparse",
            "cusolver",
            "nccl",
            "nvjitlink",
            "cu12",
            "cu13",
        )
        for name in preferred:
            candidate = base / name / "lib"
            if candidate.is_dir():
                discovered.append(str(candidate))

        for candidate in sorted(base.glob("*/lib")):
            text = str(candidate)
            if candidate.is_dir() and text not in discovered:
                discovered.append(text)

    existing = [segment.strip() for segment in str(os.getenv("LD_LIBRARY_PATH", "")).split(":") if segment.strip()]
    merged: list[str] = []
    for item in [*discovered, *existing]:
        if item not in merged:
            merged.append(item)
    if merged:
        os.environ["LD_LIBRARY_PATH"] = ":".join(merged)

    nvrtc_candidates = []
    for folder in discovered:
        nvrtc_candidates.extend(sorted(glob.glob(os.path.join(folder, "libnvrtc-builtins.so*"))))
    logger.info("LD_LIBRARY_PATH prepared (%s entries)", len(merged))
    logger.info("NVRTC builtins candidates: %s", nvrtc_candidates[:20])


def _log_torch_runtime_info() -> None:
    try:
        import torch

        logger.info(
            "torch runtime: version=%s cuda=%s cuda_available=%s device_count=%s",
            getattr(torch, "__version__", "unknown"),
            getattr(torch.version, "cuda", None),
            torch.cuda.is_available(),
            torch.cuda.device_count() if torch.cuda.is_available() else 0,
        )
    except Exception:  # noqa: BLE001
        logger.exception("failed to log torch runtime info")


def _connect_with_retry(params: pika.URLParameters) -> pika.BlockingConnection:
    retry_delay_sec = max(1, int(os.getenv("RABBITMQ_CONNECT_RETRY_DELAY_SEC", "3")))
    max_attempts = int(os.getenv("RABBITMQ_CONNECT_MAX_ATTEMPTS", "0"))
    attempt = 0

    while True:
        attempt += 1
        try:
            logger.info("connecting to RabbitMQ attempt=%s", attempt)
            return pika.BlockingConnection(params)
        except (pika.exceptions.AMQPConnectionError, socket.gaierror, OSError) as exc:
            if max_attempts > 0 and attempt >= max_attempts:
                logger.exception("failed to connect to RabbitMQ after %s attempts", attempt)
                raise
            logger.warning(
                "RabbitMQ is unavailable (%s), retrying in %ss (attempt=%s)",
                exc.__class__.__name__,
                retry_delay_sec,
                attempt,
            )
            time.sleep(retry_delay_sec)


def _start_http_server(worker_type: str) -> threading.Thread | None:
    if str(os.getenv("WORKER_HTTP_ENABLED", "1")).strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return None

    if worker_type == "embedder":
        from backend.models.embedder.embedder import app as model_app

        port = int(os.getenv("EMBEDDER_PORT", "8000"))
    else:
        from backend.models.vlm.vlm import app as model_app

        port = int(os.getenv("VLM_PORT", "8001"))

    log_level = str(os.getenv("WORKER_HTTP_LOG_LEVEL", "info")).strip().lower() or "info"
    _suppress_healthcheck_access_logs()

    def _run() -> None:
        logger.info(
            "starting worker HTTP server: worker=%s host=0.0.0.0 port=%s",
            worker_type,
            port,
        )
        uvicorn.run(
            model_app,
            host="0.0.0.0",
            port=port,
            log_level=log_level,
        )

    thread = threading.Thread(
        target=_run,
        name=f"{worker_type}-http-server",
        daemon=True,
    )
    thread.start()
    return thread


def _reply(ch, props, response: Dict[str, Any]) -> None:
    if not props.reply_to:
        return
    ch.basic_publish(
        exchange="",
        routing_key=props.reply_to,
        properties=pika.BasicProperties(
            correlation_id=props.correlation_id,
            content_type="application/json",
        ),
        body=json.dumps(response).encode("utf-8"),
    )


def _consume_with_http_priority(
    ch,
    queue_name: str,
    handler,
    has_active_http_requests,
    worker_name: str,
) -> None:
    prefetch = int(os.getenv("RABBITMQ_PREFETCH", "1"))
    poll_interval_sec = float(os.getenv("RABBITMQ_POLL_INTERVAL_SEC", "0.1"))
    http_grace_sec = float(os.getenv("WORKER_HTTP_PRIORITY_GRACE_SEC", "0.5"))
    ch.basic_qos(prefetch_count=max(1, prefetch))
    logger.info(
        "%s worker consuming queue=%s with HTTP-aware polling grace=%.3fs",
        worker_name,
        queue_name,
        http_grace_sec,
    )
    while True:
        if has_active_http_requests(http_grace_sec):
            time.sleep(poll_interval_sec)
            continue
        method, props, body = ch.basic_get(queue=queue_name, auto_ack=False)
        if method is None:
            time.sleep(poll_interval_sec)
            continue
        handler(ch, method, props, body)


def run_embedder_worker(ch, queue_name: str) -> None:
    from backend.models.embedder.embedder import get_embedding
    from backend.models.embedder.embedder import has_active_http_requests
    from backend.models.embedder.embedder import get_embeddings

    def _handle_message(channel, method, props, body):
        started_at = time.monotonic()
        task_name = "unknown"
        status = "error"
        try:
            payload = json.loads(body.decode("utf-8"))
            task = str(payload.get("task", "")).strip()
            task_name = task or "unknown"
            if task == "embed_text":
                text = str(payload.get("text", ""))
                embedding = get_embedding(text, type="text")
                response = {"ok": True, "embedding": embedding, "dim": len(embedding)}
                status = "ok"
            elif task == "embed_image":
                encoded = str(payload.get("image_base64", "")).strip()
                image_bytes = base64.b64decode(encoded)
                image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
                embedding = get_embedding(image, type="image")
                response = {"ok": True, "embedding": embedding, "dim": len(embedding)}
                status = "ok"
            elif task == "embed_image_batch":
                encoded_images = payload.get("images_base64", [])
                if not isinstance(encoded_images, list) or not encoded_images:
                    raise ValueError("images_base64 must be a non-empty list")
                images: list[Image.Image] = []
                for encoded in encoded_images:
                    image_bytes = base64.b64decode(str(encoded).strip())
                    images.append(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
                embeddings = get_embeddings(images, type="image")
                dim = len(embeddings[0]) if embeddings else 0
                response = {"ok": True, "embeddings": embeddings, "dim": dim}
                status = "ok"
            else:
                response = {"ok": False, "error": f"unknown embedder task: {task}"}
        except Exception as exc:  # noqa: BLE001
            response = {
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }
        _reply(channel, props, response)
        channel.basic_ack(delivery_tag=method.delivery_tag)
        observe_job("embedder", task_name, status, time.monotonic() - started_at)

    _consume_with_http_priority(
        ch,
        queue_name,
        _handle_message,
        has_active_http_requests,
        "embedder",
    )


def run_vlm_worker(ch, queue_name: str) -> None:
    from backend.models.vlm.vlm import _generate_text
    from backend.models.vlm.vlm import has_active_http_requests

    def _handle_message(channel, method, props, body):
        started_at = time.monotonic()
        task_name = "unknown"
        status = "error"
        try:
            payload = json.loads(body.decode("utf-8"))
            task = str(payload.get("task", "")).strip()
            task_name = task or "unknown"
            if task != "generate_vlm":
                raise ValueError(f"unknown vlm task: {task}")
            encoded = str(payload.get("image_base64", "")).strip()
            image_bytes = base64.b64decode(encoded)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            prompt = str(payload.get("prompt", ""))
            max_new_tokens = int(payload.get("max_new_tokens", 64))
            generated = _generate_text(image, prompt, max_new_tokens)
            response = {"ok": True, "response": generated}
            status = "ok"
        except Exception as exc:  # noqa: BLE001
            response = {
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }
        _reply(channel, props, response)
        channel.basic_ack(delivery_tag=method.delivery_tag)
        observe_job("vlm", task_name, status, time.monotonic() - started_at)

    _consume_with_http_priority(
        ch,
        queue_name,
        _handle_message,
        has_active_http_requests,
        "vlm",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run RabbitMQ model worker")
    parser.add_argument("--worker", choices=["embedder", "vlm"], required=True)
    args = parser.parse_args()
    startup_log = setup_worker_startup_logging(args.worker)
    root_logger = logging.getLogger()
    if not any(
        isinstance(handler, logging.FileHandler)
        and getattr(handler, "baseFilename", "").endswith(f"{startup_log.worker}.log")
        for handler in root_logger.handlers
    ):
        file_handler = logging.FileHandler(startup_log.path, encoding="utf-8")
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s:%(name)s:%(message)s")
        )
        root_logger.addHandler(file_handler)
    logger.info("startup logs enabled: worker=%s path=%s", startup_log.worker, startup_log.path)
    _prepare_cuda_library_path()
    _log_torch_runtime_info()

    rabbit_url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/%2f")
    embedder_queue = os.getenv("RABBITMQ_EMBEDDER_QUEUE", "avsp.embedder.tasks")
    vlm_queue = os.getenv("RABBITMQ_VLM_QUEUE", "avsp.vlm.tasks")

    start_metrics_server(args.worker)
    _start_http_server(args.worker)

    params = pika.URLParameters(rabbit_url)
    heartbeat_sec = int(os.getenv("RABBITMQ_HEARTBEAT_SEC", "900"))
    blocked_timeout_sec = int(
        os.getenv("RABBITMQ_BLOCKED_CONNECTION_TIMEOUT_SEC", str(max(300, heartbeat_sec + 60)))
    )
    params.heartbeat = max(30, heartbeat_sec)
    params.blocked_connection_timeout = max(60, blocked_timeout_sec)
    connection = _connect_with_retry(params)
    channel = connection.channel()

    channel.queue_declare(queue=embedder_queue, durable=True)
    channel.queue_declare(queue=vlm_queue, durable=True)

    if args.worker == "embedder":
        run_embedder_worker(channel, embedder_queue)
    else:
        run_vlm_worker(channel, vlm_queue)


if __name__ == "__main__":
    main()

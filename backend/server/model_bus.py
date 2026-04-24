from __future__ import annotations

import base64
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class RabbitConfig:
    url: str
    embedder_queue: str
    vlm_queue: str
    timeout_sec: int


class RabbitRPCError(RuntimeError):
    pass


class RabbitRPCClient:
    def __init__(self, cfg: RabbitConfig):
        self.cfg = cfg
        self._local = threading.local()

    def _get_channel(self):
        import pika

        conn = getattr(self._local, "connection", None)
        ch = getattr(self._local, "channel", None)
        if conn and ch and conn.is_open and ch.is_open:
            return conn, ch

        params = pika.URLParameters(self.cfg.url)
        params.heartbeat = max(10, self.cfg.timeout_sec * 2)
        params.blocked_connection_timeout = self.cfg.timeout_sec + 5
        conn = pika.BlockingConnection(params)
        ch = conn.channel()
        ch.queue_declare(queue=self.cfg.embedder_queue, durable=True)
        ch.queue_declare(queue=self.cfg.vlm_queue, durable=True)
        responses: Dict[str, Dict[str, Any]] = {}

        def _on_response(_ch, _method, props, body):
            corr_id = getattr(props, "correlation_id", None)
            if not corr_id:
                return
            try:
                responses[corr_id] = json.loads(body.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                responses[corr_id] = {
                    "ok": False,
                    "error": f"invalid worker response: {exc}",
                }

        consumer_tag = ch.basic_consume(
            queue="amq.rabbitmq.reply-to",
            on_message_callback=_on_response,
            auto_ack=True,
        )
        self._local.connection = conn
        self._local.channel = ch
        self._local.responses = responses
        self._local.consumer_tag = consumer_tag
        return conn, ch

    def close(self) -> None:
        conn = getattr(self._local, "connection", None)
        ch = getattr(self._local, "channel", None)
        consumer_tag = getattr(self._local, "consumer_tag", None)
        try:
            if ch and ch.is_open and consumer_tag:
                ch.basic_cancel(consumer_tag=consumer_tag)
        except Exception:  # noqa: BLE001
            pass
        try:
            if conn and conn.is_open:
                conn.close()
        finally:
            self._local.connection = None
            self._local.channel = None
            self._local.responses = None
            self._local.consumer_tag = None

    def call(self, queue_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        import pika

        conn, ch = self._get_channel()
        corr_id = str(uuid.uuid4())
        responses = getattr(self._local, "responses", None)
        if responses is None:
            raise RabbitRPCError("rpc response consumer is not initialized")

        responses.pop(corr_id, None)
        ch.basic_publish(
            exchange="",
            routing_key=queue_name,
            properties=pika.BasicProperties(
                correlation_id=corr_id,
                reply_to="amq.rabbitmq.reply-to",
                content_type="application/json",
                delivery_mode=2,
            ),
            body=json.dumps(payload).encode("utf-8"),
        )

        deadline = time.monotonic() + self.cfg.timeout_sec
        while time.monotonic() < deadline:
            response = responses.pop(corr_id, None)
            if response is not None:
                if not response.get("ok", False):
                    raise RabbitRPCError(str(response.get("error", "worker error")))
                return response
            conn.process_data_events(time_limit=0.2)

        raise RabbitRPCError(f"rpc timeout waiting for queue={queue_name}")

    def health_snapshot(self) -> Dict[str, Any]:
        _, ch = self._get_channel()
        queues: Dict[str, Dict[str, int]] = {}
        for queue_name in (self.cfg.embedder_queue, self.cfg.vlm_queue):
            declared = ch.queue_declare(queue=queue_name, passive=True)
            method = declared.method
            queues[queue_name] = {
                "messages": int(getattr(method, "message_count", 0)),
                "consumers": int(getattr(method, "consumer_count", 0)),
            }
        return {"connected": True, "queues": queues}


class ModelGateway:
    def __init__(self):
        self.mode = os.getenv("MODEL_EXECUTION_MODE", "rabbitmq").strip().lower()
        rabbit_url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/%2f")
        embedder_queue = os.getenv("RABBITMQ_EMBEDDER_QUEUE", "avsp.embedder.tasks")
        vlm_queue = os.getenv("RABBITMQ_VLM_QUEUE", "avsp.vlm.tasks")
        timeout_sec = int(os.getenv("RABBITMQ_RPC_TIMEOUT_SEC", "120"))
        self._rpc: Optional[RabbitRPCClient] = None
        if self.mode == "rabbitmq":
            self._rpc = RabbitRPCClient(
                RabbitConfig(
                    url=rabbit_url,
                    embedder_queue=embedder_queue,
                    vlm_queue=vlm_queue,
                    timeout_sec=max(1, timeout_sec),
                )
            )

    def health(self) -> Dict[str, Any]:
        if self.mode != "rabbitmq":
            return {"status": "ok", "mode": self.mode}
        if self._rpc is None:
            return {
                "status": "error",
                "mode": self.mode,
                "error": "rabbitmq mode selected but RPC client is not initialized",
            }
        try:
            snapshot = self._rpc.health_snapshot()
            queues = snapshot.get("queues", {})
            missing_consumers = []
            for queue_name, stats in queues.items():
                if int(stats.get("consumers", 0)) <= 0:
                    missing_consumers.append(queue_name)
            if missing_consumers:
                return {
                    "status": "error",
                    "mode": self.mode,
                    "error": "no active consumers for one or more queues",
                    "missing_consumers": missing_consumers,
                    "rabbitmq": snapshot,
                }
            return {"status": "ok", "mode": self.mode, "rabbitmq": snapshot}
        except Exception as exc:  # noqa: BLE001
            return {
                "status": "error",
                "mode": self.mode,
                "error": str(exc),
            }

    def embed_image_http(self, http_client, embedder_endpoint: str, image_bytes: bytes):
        response = http_client.post(f"{embedder_endpoint}/embedding/image_bytes", content=image_bytes)
        response.raise_for_status()
        payload = response.json()
        return payload["embedding"], payload["dim"]

    def embed_text_http(self, http_client, embedder_endpoint: str, text: str):
        response = http_client.post(f"{embedder_endpoint}/embedding/text", params={"text": text})
        response.raise_for_status()
        payload = response.json()
        return payload["embedding"], payload["dim"]

    def run_vlm_http(self, http_client, vlm_endpoint: str, *, image_bytes: bytes, prompt: str, max_new_tokens: int, metadata: Dict[str, Any]) -> str:
        response = http_client.post(
            f"{vlm_endpoint}/generate",
            data={
                "prompt": prompt,
                "max_new_tokens": str(max_new_tokens),
                "job_id": str(metadata.get("job_id") or ""),
                "task_index": str(metadata.get("task_index")) if metadata.get("task_index") is not None else "",
                "task_total": str(metadata.get("task_total")) if metadata.get("task_total") is not None else "",
                "field_name": str(metadata.get("field_name") or ""),
                "object_id": str(metadata.get("object_id") or ""),
            },
            files={"file": ("image.jpg", image_bytes, "image/jpeg")},
        )
        response.raise_for_status()
        return response.json()["response"].strip()

    def embed_image(self, http_client, embedder_endpoint: str, image_bytes: bytes):
        if self.mode != "rabbitmq" or self._rpc is None:
            return self.embed_image_http(http_client, embedder_endpoint, image_bytes)
        payload = {
            "task": "embed_image",
            "image_base64": base64.b64encode(image_bytes).decode("ascii"),
        }
        result = self._rpc.call(self._rpc.cfg.embedder_queue, payload)
        return result["embedding"], int(result["dim"])

    def embed_text(self, http_client, embedder_endpoint: str, text: str):
        if self.mode != "rabbitmq" or self._rpc is None:
            return self.embed_text_http(http_client, embedder_endpoint, text)
        payload = {
            "task": "embed_text",
            "text": text,
        }
        result = self._rpc.call(self._rpc.cfg.embedder_queue, payload)
        return result["embedding"], int(result["dim"])

    def run_vlm(
        self,
        http_client,
        vlm_endpoint: str,
        *,
        image_bytes: bytes,
        prompt: str,
        max_new_tokens: int,
        metadata: Dict[str, Any],
    ) -> str:
        if self.mode != "rabbitmq" or self._rpc is None:
            return self.run_vlm_http(
                http_client,
                vlm_endpoint,
                image_bytes=image_bytes,
                prompt=prompt,
                max_new_tokens=max_new_tokens,
                metadata=metadata,
            )
        payload = {
            "task": "generate_vlm",
            "image_base64": base64.b64encode(image_bytes).decode("ascii"),
            "prompt": prompt,
            "max_new_tokens": int(max_new_tokens),
            "metadata": metadata,
        }
        result = self._rpc.call(self._rpc.cfg.vlm_queue, payload)
        return str(result.get("response", "")).strip()

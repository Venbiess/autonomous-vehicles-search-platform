from __future__ import annotations

import argparse
import base64
import io
import json
import logging
import os
from typing import Any, Dict

import pika
from PIL import Image

logger = logging.getLogger("avsp.model-worker")
logging.basicConfig(level=logging.INFO)


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


def run_embedder_worker(ch, queue_name: str) -> None:
    from backend.models.embedder.embedder import get_embedding

    def _on_message(channel, method, props, body):
        try:
            payload = json.loads(body.decode("utf-8"))
            task = str(payload.get("task", "")).strip()
            if task == "embed_text":
                text = str(payload.get("text", ""))
                embedding = get_embedding(text, type="text")
                response = {"ok": True, "embedding": embedding, "dim": len(embedding)}
            elif task == "embed_image":
                encoded = str(payload.get("image_base64", "")).strip()
                image_bytes = base64.b64decode(encoded)
                image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
                embedding = get_embedding(image, type="image")
                response = {"ok": True, "embedding": embedding, "dim": len(embedding)}
            else:
                response = {"ok": False, "error": f"unknown embedder task: {task}"}
        except Exception as exc:  # noqa: BLE001
            response = {"ok": False, "error": str(exc)}
        _reply(channel, props, response)
        channel.basic_ack(delivery_tag=method.delivery_tag)

    ch.basic_qos(prefetch_count=int(os.getenv("RABBITMQ_PREFETCH", "1")))
    ch.basic_consume(queue=queue_name, on_message_callback=_on_message)
    logger.info("embedder worker consuming queue=%s", queue_name)
    ch.start_consuming()


def run_vlm_worker(ch, queue_name: str) -> None:
    from backend.models.vlm.vlm import _generate_text

    def _on_message(channel, method, props, body):
        try:
            payload = json.loads(body.decode("utf-8"))
            task = str(payload.get("task", "")).strip()
            if task != "generate_vlm":
                raise ValueError(f"unknown vlm task: {task}")
            encoded = str(payload.get("image_base64", "")).strip()
            image_bytes = base64.b64decode(encoded)
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            prompt = str(payload.get("prompt", ""))
            max_new_tokens = int(payload.get("max_new_tokens", 64))
            generated = _generate_text(image, prompt, max_new_tokens)
            response = {"ok": True, "response": generated}
        except Exception as exc:  # noqa: BLE001
            response = {"ok": False, "error": str(exc)}
        _reply(channel, props, response)
        channel.basic_ack(delivery_tag=method.delivery_tag)

    ch.basic_qos(prefetch_count=int(os.getenv("RABBITMQ_PREFETCH", "1")))
    ch.basic_consume(queue=queue_name, on_message_callback=_on_message)
    logger.info("vlm worker consuming queue=%s", queue_name)
    ch.start_consuming()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run RabbitMQ model worker")
    parser.add_argument("--worker", choices=["embedder", "vlm"], required=True)
    args = parser.parse_args()

    rabbit_url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/%2f")
    embedder_queue = os.getenv("RABBITMQ_EMBEDDER_QUEUE", "avsp.embedder.tasks")
    vlm_queue = os.getenv("RABBITMQ_VLM_QUEUE", "avsp.vlm.tasks")

    params = pika.URLParameters(rabbit_url)
    params.heartbeat = 120
    params.blocked_connection_timeout = 300
    connection = pika.BlockingConnection(params)
    channel = connection.channel()

    channel.queue_declare(queue=embedder_queue, durable=True)
    channel.queue_declare(queue=vlm_queue, durable=True)

    if args.worker == "embedder":
        run_embedder_worker(channel, embedder_queue)
    else:
        run_vlm_worker(channel, vlm_queue)


if __name__ == "__main__":
    main()

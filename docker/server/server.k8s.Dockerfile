FROM python:3.10-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY docker/server/requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt

COPY backend /app/backend
COPY configs /app/configs

CMD ["uvicorn", "backend.server.master:app", "--host", "0.0.0.0", "--port", "9002", "--log-level", "info"]

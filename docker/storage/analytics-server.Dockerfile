FROM python:3.10-slim

WORKDIR /app/backend/column-storage
COPY backend/column-storage /app/backend/column-storage

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir -r requirements.txt

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9012", "--log-level", "info"]

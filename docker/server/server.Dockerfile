FROM python:3.10-slim

WORKDIR /app

# -----------------------------
# Build arguments (from configs)
# -----------------------------
COPY configs/ /app/configs/
ENV PYTHONPATH=/app
RUN python - <<'PY' > /tmp/build.env
from configs.common import DATASETS
need_waymo = "WAYMO" in DATASETS
print(f"NEED_WAYMO={'1' if need_waymo else '0'}")

if need_waymo:
    from configs.waymo import PROJECT_NAME, GCLOUD_PROJECT, ENVIRONMENT
    print(f"PROJECT_NAME={PROJECT_NAME}")
    print(f"GCLOUD_PROJECT={GCLOUD_PROJECT}")
    print(f"ENVIRONMENT={ENVIRONMENT}")
PY

# -----------------------------
# Environment variables
# -----------------------------
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

# -----------------------------
# System dependencies
# -----------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 curl gnupg ca-certificates; \
    \
    . /tmp/build.env; \
# -----------------------------
# Install Google Cloud SDK
# -----------------------------
    if [ "$NEED_WAYMO" = "1" ]; then \
      curl -sSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg; \
      echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
        > /etc/apt/sources.list.d/google-cloud-sdk.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends google-cloud-sdk; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# -----------------------------
# Python dependencies
# -----------------------------
COPY docker/server/requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt

CMD ["tail", "-f", "/dev/null"]

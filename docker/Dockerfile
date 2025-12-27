FROM python:3.10-slim

# -----------------------------
# Build arguments (from configs)
# -----------------------------
ARG PROJECT_NAME
ARG GCLOUD_PROJECT
ARG ENVIRONMENT
ARG APP_DIR=/app

# -----------------------------
# Environment variables
# -----------------------------
ENV PROJECT_NAME=${PROJECT_NAME}
ENV GCLOUD_PROJECT=${GCLOUD_PROJECT}
ENV ENVIRONMENT=${ENVIRONMENT}
ENV APP_DIR=${APP_DIR}

ENV CLOUDSDK_CORE_PROJECT=${GCLOUD_PROJECT}
ENV CLOUDSDK_AUTH_DISABLE_PROMPTS=1

# -----------------------------
# System dependencies
# -----------------------------
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    curl \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------
# Install Google Cloud SDK
# -----------------------------
RUN curl -sSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
    https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list && \
    apt-get update && apt-get install -y google-cloud-sdk \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------
# Python dependencies
# -----------------------------
WORKDIR /app
COPY docker/requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY docker/setup.py /setup.py

ENTRYPOINT ["/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]


FROM golang:1.22-alpine

WORKDIR /app/backend/storage
COPY backend/storage /app/backend/storage
RUN go build -o /usr/local/bin/object-service ./cmd/object-service

EXPOSE 9010
CMD ["/usr/local/bin/object-service"]

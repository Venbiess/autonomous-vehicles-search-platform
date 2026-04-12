FROM golang:1.22-alpine

WORKDIR /app/backend/storage
COPY backend/storage /app/backend/storage
RUN go build -o /usr/local/bin/vector-service ./cmd/vector-service

EXPOSE 9011
CMD ["/usr/local/bin/vector-service"]

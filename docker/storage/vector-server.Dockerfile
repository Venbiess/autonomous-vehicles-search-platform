FROM golang:1.22-alpine

WORKDIR /app/backend/storage
COPY backend/storage /app/backend/storage
RUN go build -o /usr/local/bin/vector-server ./cmd/vectorserver

EXPOSE 9011
CMD ["/usr/local/bin/vector-server"]

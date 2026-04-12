FROM golang:1.22-alpine

WORKDIR /app/backend/storage
COPY backend/storage /app/backend/storage
RUN go build -o /usr/local/bin/object-server ./cmd/objectserver

EXPOSE 9010
CMD ["/usr/local/bin/object-server"]

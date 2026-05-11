FROM golang:1.25-alpine

WORKDIR /app/storage
COPY storage/go.mod storage/go.sum ./
RUN go mod download

COPY storage /app/storage
RUN go build -o /usr/local/bin/storage-server ./cmd/storageserver

EXPOSE 9012
CMD ["/usr/local/bin/storage-server"]

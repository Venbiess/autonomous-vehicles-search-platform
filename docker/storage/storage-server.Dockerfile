FROM golang:1.22-alpine

WORKDIR /app/storage
COPY storage /app/storage
RUN go build -o /usr/local/bin/storage-server ./cmd/storageserver

EXPOSE 9012
CMD ["/usr/local/bin/storage-server"]

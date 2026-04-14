FROM golang:1.22-alpine

WORKDIR /app/storage
COPY storage /app/storage
RUN go build -o /usr/local/bin/coordinator-server ./cmd/coordinatorserver

EXPOSE 9013
CMD ["/usr/local/bin/coordinator-server"]

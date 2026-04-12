FROM golang:1.22-alpine

WORKDIR /app/backend/storage
COPY backend/storage /app/backend/storage
RUN go build -o /usr/local/bin/analytics-server ./cmd/analyticsserver

EXPOSE 9012
CMD ["/usr/local/bin/analytics-server"]

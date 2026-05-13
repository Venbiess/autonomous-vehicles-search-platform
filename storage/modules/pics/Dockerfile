FROM golang:1.25 AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/coordinator ./cmd/coordinator
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/volume ./cmd/volume

FROM alpine:3.20 AS coordinator
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY --from=build /out/coordinator /app/coordinator
ENTRYPOINT ["/app/coordinator"]

FROM alpine:3.20 AS volume
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY --from=build /out/volume /app/volume
ENTRYPOINT ["/app/volume"]

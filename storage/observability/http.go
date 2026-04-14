package observability

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
)

const requestIDHeader = "X-Request-ID"

type contextKey string

const requestIDKey contextKey = "request_id"

var (
	registerMetrics  sync.Once
	requestsTotal    *prometheus.CounterVec
	requestDuration  *prometheus.HistogramVec
	inFlight         *prometheus.GaugeVec
	requestSizeBytes *prometheus.HistogramVec
	responseSize     *prometheus.HistogramVec
	panicTotal       *prometheus.CounterVec
)

func Middleware(service string, next http.Handler) http.Handler {
	registerMetrics.Do(func() {
		requestsTotal = prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "avsp_storage_http_requests_total",
				Help: "Total HTTP requests processed by storage servers.",
			},
			[]string{"service", "method", "path", "status", "status_class"},
		)
		requestDuration = prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "avsp_storage_http_request_duration_seconds",
				Help:    "HTTP request latency in seconds for storage servers.",
				Buckets: prometheus.DefBuckets,
			},
			[]string{"service", "method", "path"},
		)
		inFlight = prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "avsp_storage_http_in_flight_requests",
				Help: "Current number of in-flight HTTP requests for storage servers.",
			},
			[]string{"service"},
		)
		requestSizeBytes = prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "avsp_storage_http_request_size_bytes",
				Help:    "HTTP request payload size in bytes.",
				Buckets: []float64{256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304},
			},
			[]string{"service", "method", "path"},
		)
		responseSize = prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "avsp_storage_http_response_size_bytes",
				Help:    "HTTP response payload size in bytes.",
				Buckets: []float64{256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304},
			},
			[]string{"service", "method", "path", "status_class"},
		)
		panicTotal = prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "avsp_storage_http_panics_total",
				Help: "Total recovered panics in HTTP handlers.",
			},
			[]string{"service", "path"},
		)
		prometheus.MustRegister(requestsTotal, requestDuration, inFlight, requestSizeBytes, responseSize, panicTotal)
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		inFlight.WithLabelValues(service).Inc()
		defer inFlight.WithLabelValues(service).Dec()

		requestID := getOrCreateRequestID(r.Header.Get(requestIDHeader))
		ctx := context.WithValue(r.Context(), requestIDKey, requestID)
		r = r.WithContext(ctx)

		rec := &statusRecorder{
			ResponseWriter: w,
			status:         http.StatusOK,
		}
		rec.Header().Set(requestIDHeader, requestID)

		path := normalizePathLabel(r.URL.Path)
		method := r.Method
		reqSize := requestContentLength(r)
		requestSizeBytes.WithLabelValues(service, method, path).Observe(float64(reqSize))

		defer func() {
			if recovered := recover(); recovered != nil {
				panicTotal.WithLabelValues(service, path).Inc()
				rec.status = http.StatusInternalServerError
				http.Error(rec, "internal server error", http.StatusInternalServerError)
				LogError("http_panic_recovered", map[string]any{
					"service":    service,
					"method":     method,
					"path":       path,
					"request_id": requestID,
					"panic":      recovered,
					"stack":      string(debug.Stack()),
				})
			}

			duration := time.Since(started)
			status := strconv.Itoa(rec.status)
			statusClass := statusClass(rec.status)
			requestsTotal.WithLabelValues(service, method, path, status, statusClass).Inc()
			requestDuration.WithLabelValues(service, method, path).Observe(duration.Seconds())
			responseSize.WithLabelValues(service, method, path, statusClass).Observe(float64(rec.bytesWritten))

			LogInfo("http_request", map[string]any{
				"service":              service,
				"request_id":           requestID,
				"method":               method,
				"path":                 path,
				"status":               rec.status,
				"status_class":         statusClass,
				"duration_ms":          duration.Milliseconds(),
				"request_size_bytes":   reqSize,
				"response_size_bytes":  rec.bytesWritten,
				"remote_addr":          r.RemoteAddr,
				"user_agent":           r.UserAgent(),
				"x_forwarded_for":      strings.TrimSpace(r.Header.Get("X-Forwarded-For")),
				"x_forwarded_proto":    strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")),
				"x_forwarded_host":     strings.TrimSpace(r.Header.Get("X-Forwarded-Host")),
				"x_real_ip":            strings.TrimSpace(r.Header.Get("X-Real-IP")),
				"request_content_type": strings.TrimSpace(r.Header.Get("Content-Type")),
			})
		}()

		next.ServeHTTP(rec, r)
	})
}

func RequestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	requestID, _ := ctx.Value(requestIDKey).(string)
	return requestID
}

func LogInfo(event string, fields map[string]any) {
	writeLog("info", event, fields)
}

func LogError(event string, fields map[string]any) {
	writeLog("error", event, fields)
}

func writeLog(level, event string, fields map[string]any) {
	payload := map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"level":     level,
		"event":     event,
	}
	for key, value := range fields {
		payload[key] = value
	}
	line, err := json.Marshal(payload)
	if err != nil {
		log.Printf(`{"level":"error","event":"log_marshal_failed","error":%q}`, err.Error())
		return
	}
	log.Print(string(line))
}

func getOrCreateRequestID(incoming string) string {
	incoming = strings.TrimSpace(incoming)
	if incoming != "" {
		return incoming
	}
	return uuid.NewString()
}

func requestContentLength(r *http.Request) int64 {
	if r.ContentLength > 0 {
		return r.ContentLength
	}
	return 0
}

func statusClass(code int) string {
	switch {
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	case code >= 500 && code < 600:
		return "5xx"
	default:
		return "other"
	}
}

func normalizePathLabel(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	parts := strings.Split(path, "/")
	for idx := range parts {
		if idx == 0 || parts[idx] == "" {
			continue
		}
		part := parts[idx]
		if looksLikeUUID(part) || looksNumeric(part) {
			parts[idx] = ":id"
		}
	}
	return strings.Join(parts, "/")
}

func looksNumeric(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func looksLikeUUID(value string) bool {
	_, err := uuid.Parse(value)
	return err == nil
}

type statusRecorder struct {
	http.ResponseWriter
	status       int
	bytesWritten int
}

func (r *statusRecorder) WriteHeader(statusCode int) {
	r.status = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	n, err := r.ResponseWriter.Write(p)
	r.bytesWritten += n
	return n, err
}

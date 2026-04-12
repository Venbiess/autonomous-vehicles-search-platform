package observability

import (
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	registerMetrics sync.Once
	requestsTotal   *prometheus.CounterVec
	requestDuration *prometheus.HistogramVec
	inFlight        *prometheus.GaugeVec
)

func Middleware(service string, next http.Handler) http.Handler {
	registerMetrics.Do(func() {
		requestsTotal = prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "avsp_storage_http_requests_total",
				Help: "Total HTTP requests processed by storage services.",
			},
			[]string{"service", "method", "path", "status"},
		)
		requestDuration = prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "avsp_storage_http_request_duration_seconds",
				Help:    "HTTP request latency in seconds for storage services.",
				Buckets: prometheus.DefBuckets,
			},
			[]string{"service", "method", "path"},
		)
		inFlight = prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "avsp_storage_http_in_flight_requests",
				Help: "Current number of in-flight HTTP requests for storage services.",
			},
			[]string{"service"},
		)
		prometheus.MustRegister(requestsTotal, requestDuration, inFlight)
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		inFlight.WithLabelValues(service).Inc()
		defer inFlight.WithLabelValues(service).Dec()

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		path := r.URL.Path
		method := r.Method
		status := strconv.Itoa(rec.status)
		durationSec := time.Since(started).Seconds()
		durationMs := time.Since(started).Milliseconds()

		requestsTotal.WithLabelValues(service, method, path, status).Inc()
		requestDuration.WithLabelValues(service, method, path).Observe(durationSec)
		log.Printf(`{"service":"%s","method":"%s","path":"%s","status":%d,"duration_ms":%d}`,
			service, method, path, rec.status, durationMs)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(statusCode int) {
	r.status = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

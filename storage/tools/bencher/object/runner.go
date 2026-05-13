package object

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultConcurrency = 6
	timeout            = 30 * time.Second
	awsRegion          = "us-east-1"
	awsService         = "s3"
	defaultStorage     = "storage"
	defaultMinIO       = "minio"
)

type config struct {
	target      string
	url         string
	uploadURL   string
	accessKey   string
	secretKey   string
	bucket      string
	sizeRaw     string
	ops         int
	concurrency int
}

type result struct {
	status  int
	latency time.Duration
	err     string
}

type runner interface {
	ensureBucket() error
	put(key string, payload []byte) result
	get(key string) result
	delete(key string) result
}

type storageRunner struct {
	baseURL       string
	uploadBaseURL string
	client        *http.Client
	bucket        string
}

type minioRunner struct {
	endpoint  string
	accessKey string
	secretKey string
	client    *http.Client
	bucket    string
}

type report struct {
	label       string
	ops         int
	concurrency int
	success     int
	errors      int
	elapsed     time.Duration
	latencies   []float64
	samples     []string
}

func RunCLI(args []string) error {
	cfg, err := parseFlagsFromArgs(args)
	if err != nil {
		return err
	}

	objectSize, err := parseSize(cfg.sizeRaw)
	if err != nil {
		return err
	}
	if objectSize <= 0 || cfg.ops <= 0 {
		return fmt.Errorf("--size and --ops must be positive")
	}
	totalBytes := int64(objectSize) * int64(cfg.ops)
	writeMBps, readMBps, uncachedRead, err := probeDiskByBytes(totalBytes)
	if err != nil {
		fmt.Printf("DISK:\n  bytes_mb=%.2f error=%q\n", float64(totalBytes)/(1024*1024), err.Error())
	} else {
		fmt.Printf(
			"DISK:\n  bytes_mb=%.2f put_like_write_mb_s=%.1f get_like_read_mb_s=%.1f uncached_read=%t\n",
			float64(totalBytes)/(1024*1024),
			writeMBps,
			readMBps,
			uncachedRead,
		)
	}

	benchRunner, err := newRunner(cfg)
	if err != nil {
		return err
	}
	if err := benchRunner.ensureBucket(); err != nil {
		return err
	}

	payload := buildPayload(cfg.target, objectSize)
	keys := buildKeys(cfg.ops)
	shuffleKeys(keys)

	putReport := runParallel("PUT", cfg.ops, cfg.concurrency, func(index int) result {
		return benchRunner.put(keys[index], payload)
	})
	getReport := runParallel("GET", cfg.ops, cfg.concurrency, func(index int) result {
		return benchRunner.get(keys[index])
	})
	deleteReport := runParallel("DELETE", cfg.ops, cfg.concurrency, func(index int) result {
		return benchRunner.delete(keys[index])
	})

	printReport(putReport, int64(objectSize))
	printReport(getReport, int64(objectSize))
	printReport(deleteReport, int64(objectSize))

	if putReport.errors > 0 || getReport.errors > 0 || deleteReport.errors > 0 {
		return errors.New("benchmark finished with errors")
	}
	return nil
}

func parseFlagsFromArgs(args []string) (config, error) {
	originalArgs := os.Args
	originalFlagSet := flag.CommandLine
	defer func() {
		os.Args = originalArgs
		flag.CommandLine = originalFlagSet
	}()

	flag.CommandLine = flag.NewFlagSet(originalArgs[0], flag.ContinueOnError)
	os.Args = append([]string{originalArgs[0]}, args...)
	return parseFlags()
}

func Main() {
	if err := RunCLI(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}

func parseFlags() (config, error) {
	cfg := config{}
	flag.StringVar(&cfg.target, "target", defaultStorage, "benchmark target: storage or minio")
	flag.StringVar(&cfg.url, "url", "http://127.0.0.1:9000", "base URL for storage coordinator or S3-compatible endpoint")
	flag.StringVar(&cfg.uploadURL, "upload-url", "", "optional base URL for upload targets returned by coordinator")
	flag.StringVar(&cfg.accessKey, "access-key", "minioadmin", "S3 access key")
	flag.StringVar(&cfg.secretKey, "secret-key", "minioadmin", "S3 secret key")
	flag.StringVar(&cfg.bucket, "bucket", "bench", "bucket name")
	flag.StringVar(&cfg.sizeRaw, "size", "", "single object size, e.g. 1KB, 10MB, 1GB")
	flag.IntVar(&cfg.ops, "ops", 0, "number of objects/operations")
	flag.IntVar(&cfg.concurrency, "concurrency", defaultConcurrency, "number of concurrent requests")
	flag.Parse()

	cfg.target = strings.ToLower(strings.TrimSpace(cfg.target))
	switch cfg.target {
	case defaultStorage, defaultMinIO:
	default:
		return config{}, fmt.Errorf("invalid --target %q, expected storage or minio", cfg.target)
	}
	if cfg.sizeRaw == "" {
		return config{}, fmt.Errorf("--size is required")
	}
	if cfg.ops <= 0 {
		return config{}, fmt.Errorf("--ops must be positive")
	}
	if cfg.concurrency <= 0 {
		return config{}, fmt.Errorf("--concurrency must be positive")
	}
	return cfg, nil
}

func newRunner(cfg config) (runner, error) {
	client := &http.Client{Timeout: timeout}
	switch cfg.target {
	case defaultStorage:
		return &storageRunner{
			baseURL:       strings.TrimRight(cfg.url, "/"),
			uploadBaseURL: strings.TrimRight(cfg.uploadURL, "/"),
			client:        client,
			bucket:        cfg.bucket,
		}, nil
	case defaultMinIO:
		return &minioRunner{
			endpoint:  strings.TrimRight(cfg.url, "/"),
			accessKey: cfg.accessKey,
			secretKey: cfg.secretKey,
			client:    client,
			bucket:    cfg.bucket,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported target %q", cfg.target)
	}
}

func (r *storageRunner) ensureBucket() error {
	return nil
}

func (r *storageRunner) put(key string, payload []byte) result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	plan, err := r.createUpload(ctx, key, int64(len(payload)), "application/octet-stream")
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	if len(plan.Targets) == 0 {
		return result{status: -1, latency: time.Since(started), err: "upload plan has no targets"}
	}
	target := plan.Targets[0]
	uploadURL := r.resolveUploadURL(target.UploadURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, bytes.NewReader(payload))
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	req.Header.Set("X-Upload-Token", target.UploadToken)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = int64(len(payload))
	resp, err := r.client.Do(req)
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return result{status: resp.StatusCode, latency: time.Since(started), err: string(body)}
	}
	return result{status: resp.StatusCode, latency: time.Since(started)}
}

func (r *storageRunner) get(key string) result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.objectURL(key), nil)
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return result{status: resp.StatusCode, latency: time.Since(started), err: string(body)}
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return result{status: resp.StatusCode, latency: time.Since(started)}
}

func (r *storageRunner) delete(key string) result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, r.objectURL(key), nil)
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return result{status: resp.StatusCode, latency: time.Since(started), err: string(body)}
	}
	return result{status: resp.StatusCode, latency: time.Since(started)}
}

type uploadTarget struct {
	UploadURL   string `json:"upload_url"`
	UploadToken string `json:"upload_token"`
}

type uploadCreateResponse struct {
	Targets []uploadTarget `json:"targets"`
}

func (r *storageRunner) createUpload(ctx context.Context, key string, size int64, contentType string) (uploadCreateResponse, error) {
	reqBody := map[string]any{
		"bucket":       r.bucket,
		"key":          key,
		"content_type": contentType,
		"size":         size,
	}
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return uploadCreateResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/uploads", bytes.NewReader(raw))
	if err != nil {
		return uploadCreateResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return uploadCreateResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return uploadCreateResponse{}, fmt.Errorf("create upload failed: status=%d body=%s", resp.StatusCode, string(body))
	}
	var out uploadCreateResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return uploadCreateResponse{}, err
	}
	return out, nil
}

func (r *storageRunner) resolveUploadURL(rawURL string) string {
	if r.uploadBaseURL == "" {
		return rawURL
	}
	uploadBase, err := url.Parse(r.uploadBaseURL)
	if err != nil || uploadBase.Scheme == "" || uploadBase.Host == "" {
		return rawURL
	}
	targetURL, err := url.Parse(rawURL)
	if err != nil || targetURL.Scheme == "" || targetURL.Host == "" {
		return rawURL
	}
	targetURL.Scheme = uploadBase.Scheme
	targetURL.Host = uploadBase.Host
	return targetURL.String()
}

func (r *storageRunner) objectURL(key string) string {
	parts := strings.Split(key, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return r.baseURL + "/b/" + url.PathEscape(r.bucket) + "/" + strings.Join(parts, "/")
}

func (r *minioRunner) ensureBucket() error {
	res := r.doSignedRequest(http.MethodPut, canonicalURI(r.bucket, ""), nil, nil)
	if res.status == http.StatusOK || res.status == http.StatusNoContent || res.status == http.StatusConflict {
		return nil
	}
	return fmt.Errorf("create bucket failed: status=%d err=%s", res.status, res.err)
}

func (r *minioRunner) put(key string, payload []byte) result {
	return r.doSignedRequest(http.MethodPut, canonicalURI(r.bucket, key), payload, map[string]string{
		"content-type": "application/octet-stream",
	})
}

func (r *minioRunner) get(key string) result {
	return r.doSignedRequest(http.MethodGet, canonicalURI(r.bucket, key), nil, nil)
}

func (r *minioRunner) delete(key string) result {
	return r.doSignedRequest(http.MethodDelete, canonicalURI(r.bucket, key), nil, nil)
}

func (r *minioRunner) doSignedRequest(method, path string, body []byte, extraHeaders map[string]string) result {
	if body == nil {
		body = []byte{}
	}
	headers, err := signRequest(r.accessKey, r.secretKey, method, r.endpoint, path, body, extraHeaders)
	if err != nil {
		return result{status: -1, err: err.Error()}
	}
	req, err := http.NewRequest(method, r.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return result{status: -1, err: err.Error()}
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	started := time.Now()
	resp, err := r.client.Do(req)
	if err != nil {
		return result{status: -1, latency: time.Since(started), err: err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	detail := ""
	if resp.StatusCode >= 300 {
		detail = strings.TrimSpace(string(raw))
	}
	return result{status: resp.StatusCode, latency: time.Since(started), err: detail}
}

func signRequest(accessKey, secretKey, method, endpoint, path string, body []byte, extraHeaders map[string]string) (map[string]string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	payloadHash := sha256Hex(body)

	headers := map[string]string{
		"host":                 parsed.Host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date":           amzDate,
	}
	for name, value := range extraHeaders {
		headers[strings.ToLower(name)] = value
	}

	signedNames := make([]string, 0, len(headers))
	for name := range headers {
		signedNames = append(signedNames, name)
	}
	sort.Strings(signedNames)

	var canonicalHeaders strings.Builder
	for _, name := range signedNames {
		canonicalHeaders.WriteString(name)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(strings.TrimSpace(headers[name]))
		canonicalHeaders.WriteByte('\n')
	}
	signedHeaders := strings.Join(signedNames, ";")
	canonicalRequest := strings.Join([]string{
		method,
		path,
		"",
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, awsRegion, awsService)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256(deriveSigningKey(secretKey, dateStamp), []byte(stringToSign)))
	authorization := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKey,
		credentialScope,
		signedHeaders,
		signature,
	)

	out := make(map[string]string, len(headers)+1)
	for name, value := range headers {
		out[canonicalHeaderName(name)] = value
	}
	out["Authorization"] = authorization
	return out, nil
}

func deriveSigningKey(secretKey, dateStamp string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(awsRegion))
	kService := hmacSHA256(kRegion, []byte(awsService))
	return hmacSHA256(kService, []byte("aws4_request"))
}

func hmacSHA256(key, message []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(message)
	return mac.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func canonicalHeaderName(name string) string {
	parts := strings.Split(name, "-")
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, "-")
}

func runParallel(label string, ops int, concurrency int, worker func(index int) result) report {
	results := make(chan result, ops)
	jobs := make(chan int)
	var wg sync.WaitGroup

	for range concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				results <- worker(index)
			}
		}()
	}

	started := time.Now()
	go func() {
		for i := 0; i < ops; i++ {
			jobs <- i
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	out := report{label: label, ops: ops, concurrency: concurrency}
	for res := range results {
		out.latencies = append(out.latencies, float64(res.latency)/float64(time.Millisecond))
		if res.status >= 300 || res.status < 0 {
			out.errors++
			if len(out.samples) < 5 {
				out.samples = append(out.samples, fmt.Sprintf("(%d, %q)", res.status, res.err))
			}
			continue
		}
		out.success++
	}
	out.elapsed = time.Since(started)
	return out
}

func printReport(rep report, bytesPerSuccess int64) {
	if len(rep.latencies) == 0 {
		fmt.Printf("%s: no results\n", rep.label)
		return
	}
	sort.Float64s(rep.latencies)
	rps := 0.0
	mbps := 0.0
	dataMB := 0.0
	if rep.elapsed > 0 {
		rps = float64(rep.success) / rep.elapsed.Seconds()
		dataMB = float64(rep.success*int(bytesPerSuccess)) / (1024 * 1024)
		mbps = dataMB / rep.elapsed.Seconds()
	}
	fmt.Printf("%s:\n", rep.label)
	fmt.Printf("  ops=%d success=%d errors=%d concurrency=%d\n", rep.ops, rep.success, rep.errors, rep.concurrency)
	fmt.Printf("  elapsed=%.3fs rps=%.1f data_mb=%.2f throughput_mb_s=%.1f\n", rep.elapsed.Seconds(), rps, dataMB, mbps)
	fmt.Printf(
		"  latency_ms p50=%.2f p95=%.2f max=%.2f\n",
		percentile(rep.latencies, 50),
		percentile(rep.latencies, 95),
		rep.latencies[len(rep.latencies)-1],
	)
	if len(rep.samples) > 0 {
		fmt.Printf("  sample_errors=[%s]\n", strings.Join(rep.samples, ", "))
	}
}

func probeDiskByBytes(totalBytes int64) (float64, float64, bool, error) {
	if totalBytes <= 0 {
		return 0, 0, false, fmt.Errorf("invalid probe size")
	}
	f, err := os.CreateTemp("", "bencher-disk-*")
	if err != nil {
		return 0, 0, false, err
	}
	path := f.Name()
	defer func() { _ = os.Remove(path) }()
	defer func() { _ = f.Close() }()

	chunk := make([]byte, 4*1024*1024)
	for i := range chunk {
		chunk[i] = byte(i)
	}

	startWrite := time.Now()
	var written int64
	for written < totalBytes {
		remain := totalBytes - written
		part := chunk
		if remain < int64(len(chunk)) {
			part = chunk[:remain]
		}
		n, err := f.Write(part)
		if err != nil {
			return 0, 0, false, err
		}
		written += int64(n)
	}
	if err := f.Sync(); err != nil {
		return 0, 0, false, err
	}
	writeSeconds := time.Since(startWrite).Seconds()

	uncachedRead := false
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, 0, uncachedRead, err
	}
	startRead := time.Now()
	var readBytes int64
	for readBytes < totalBytes {
		n, err := f.Read(chunk)
		if n > 0 {
			readBytes += int64(n)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, 0, uncachedRead, err
		}
	}
	readSeconds := time.Since(startRead).Seconds()
	if writeSeconds <= 0 || readSeconds <= 0 {
		return 0, 0, uncachedRead, fmt.Errorf("probe timing too small")
	}
	sizeMB := float64(totalBytes) / (1024 * 1024)
	return sizeMB / writeSeconds, sizeMB / readSeconds, uncachedRead, nil
}

func percentile(sortedValues []float64, pct float64) float64 {
	if len(sortedValues) == 0 {
		return 0
	}
	if len(sortedValues) == 1 {
		return sortedValues[0]
	}
	rank := (pct / 100) * float64(len(sortedValues)-1)
	lower := int(math.Floor(rank))
	upper := lower + 1
	if upper >= len(sortedValues) {
		upper = len(sortedValues) - 1
	}
	weight := rank - float64(lower)
	return sortedValues[lower]*(1-weight) + sortedValues[upper]*weight
}

func parseSize(raw string) (int, error) {
	value := strings.ToUpper(strings.TrimSpace(raw))
	units := []struct {
		suffix     string
		multiplier int
	}{
		{suffix: "GB", multiplier: 1024 * 1024 * 1024},
		{suffix: "MB", multiplier: 1024 * 1024},
		{suffix: "KB", multiplier: 1024},
		{suffix: "B", multiplier: 1},
	}
	for _, unit := range units {
		if !strings.HasSuffix(value, unit.suffix) {
			continue
		}
		number := strings.TrimSpace(strings.TrimSuffix(value, unit.suffix))
		if number == "" {
			break
		}
		var parsed float64
		if _, err := fmt.Sscanf(number, "%f", &parsed); err != nil {
			return 0, fmt.Errorf("invalid size %q, expected values like 1KB, 10MB, 1GB", raw)
		}
		return int(parsed * float64(unit.multiplier)), nil
	}
	return 0, fmt.Errorf("invalid size %q, expected values like 1KB, 10MB, 1GB", raw)
}

func buildPayload(target string, size int) []byte {
	chunk := []byte("sstorage-bench-")
	if target == defaultMinIO {
		chunk = []byte("minio-bench-")
	}
	repeats := (size + len(chunk) - 1) / len(chunk)
	return bytes.Repeat(chunk, repeats)[:size]
}

func buildKeys(ops int) []string {
	keys := make([]string, ops)
	for i := 0; i < ops; i++ {
		keys[i] = fmt.Sprintf("obj-%08d.bin", i)
	}
	return keys
}

func shuffleKeys(keys []string) {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	rng.Shuffle(len(keys), func(i, j int) {
		keys[i], keys[j] = keys[j], keys[i]
	})
}

func canonicalURI(bucket, key string) string {
	path := "/" + url.PathEscape(bucket)
	if key == "" {
		return path
	}
	parts := strings.Split(key, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return path + "/" + strings.Join(parts, "/")
}

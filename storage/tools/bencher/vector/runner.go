package vector

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Venbiess/autonomous-vehicles-search-platform/storage/config"
	infra "github.com/Venbiess/autonomous-vehicles-search-platform/storage/infra"
)

type vectorBatchUpserter interface {
	UpsertBatch(ctx context.Context, objectIDs []string, embeddings [][]float64) error
}

type manifest struct {
	Label      string `json:"label"`
	Provider   string `json:"provider"`
	Prefix     string `json:"prefix"`
	Count      int    `json:"count"`
	VectorSize int    `json:"vector_size"`
	Seed       int64  `json:"seed"`
}

type benchStats struct {
	Latencies []float64 `json:"-"`
	Errors    int64     `json:"errors"`
	Successes int64     `json:"successes"`
	mu        sync.Mutex
}

type benchReport struct {
	Label            string  `json:"label"`
	Mode             string  `json:"mode"`
	Provider         string  `json:"provider"`
	QueryPattern     string  `json:"query_pattern,omitempty"`
	Operations       int64   `json:"operations"`
	Errors           int64   `json:"errors"`
	DurationSec      float64 `json:"duration_sec"`
	ThroughputOpsSec float64 `json:"throughput_ops_sec"`
	AvgMs            float64 `json:"avg_ms"`
	P50Ms            float64 `json:"p50_ms"`
	P95Ms            float64 `json:"p95_ms"`
	P99Ms            float64 `json:"p99_ms"`
	MinMs            float64 `json:"min_ms"`
	MaxMs            float64 `json:"max_ms"`
}

type runReport struct {
	Label    string      `json:"label"`
	Provider string      `json:"provider"`
	Insert   benchReport `json:"insert"`
	Search   benchReport `json:"search"`
}

type runnerConfig struct {
	ConfigPath    string
	BackendType   string
	Mode          string
	Label         string
	Provider      string
	DSN           string
	Endpoint      string
	APIKey        string
	Schema        string
	Table         string
	Collection    string
	Distance      string
	IndexName     string
	SearchTopSize int
	Seed          int64
	VectorSize    int
	TopK          int
	Concurrency   int
	BatchSize     int
	SeedCount     int
	QueryCount    int
	MixedOps      int
	WritePercent  int
	QueryPattern  string
	ManifestPath  string
	Prefix        string
	HotsetSize    int
	TimeoutSec    int
	OutputJSON    bool
}

func RunCLI(args []string) error {
	cfg, err := parseFlagsFromArgs(args)
	if err != nil {
		return err
	}
	return run(cfg)
}

func parseFlagsFromArgs(args []string) (runnerConfig, error) {
	originalArgs := os.Args
	originalFlagSet := flag.CommandLine
	defer func() {
		os.Args = originalArgs
		flag.CommandLine = originalFlagSet
	}()

	flag.CommandLine = flag.NewFlagSet(originalArgs[0], flag.ContinueOnError)
	os.Args = append([]string{originalArgs[0]}, args...)

	cfg := parseFlags()
	return cfg, nil
}

func Main() {
	cfg := parseFlags()
	if err := run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "benchervs error: %v\n", err)
		os.Exit(1)
	}
}

func parseFlags() runnerConfig {
	cfg := runnerConfig{}
	flag.StringVar(&cfg.ConfigPath, "config", "", "path to storage config")
	flag.StringVar(&cfg.BackendType, "type", "", "vector backend type: pgvector|qdrant|milvus")
	flag.StringVar(&cfg.Mode, "mode", "run", "run|insert|seed|query|mixed")
	flag.StringVar(&cfg.Label, "label", "", "benchmark label")
	flag.StringVar(&cfg.DSN, "dsn", "", "database or backend DSN/connection string")
	flag.StringVar(&cfg.Endpoint, "endpoint", "", "HTTP endpoint for qdrant or milvus")
	flag.StringVar(&cfg.APIKey, "api-key", "", "API key or auth token")
	flag.StringVar(&cfg.Schema, "schema", "", "schema or database name")
	flag.StringVar(&cfg.Table, "table", "", "table or collection name")
	flag.StringVar(&cfg.Collection, "collection", "", "collection name override")
	flag.StringVar(&cfg.Distance, "distance", "cosine", "distance metric")
	flag.StringVar(&cfg.IndexName, "index-name", "", "index or view name")
	flag.IntVar(&cfg.SearchTopSize, "search-top-size", 10, "backend-specific search top size")
	flag.Int64Var(&cfg.Seed, "seed", 42, "deterministic seed")
	flag.IntVar(&cfg.VectorSize, "vector-size", 640, "vector size")
	flag.IntVar(&cfg.TopK, "topk", 10, "query top-k")
	flag.IntVar(&cfg.Concurrency, "concurrency", 8, "worker concurrency")
	flag.IntVar(&cfg.BatchSize, "batch-size", 128, "seed batch size")
	flag.IntVar(&cfg.SeedCount, "seed-count", 5000, "seed vector count")
	flag.IntVar(&cfg.QueryCount, "query-count", 1000, "query operation count")
	flag.IntVar(&cfg.MixedOps, "mixed-ops", 5000, "mixed mode total operations")
	flag.IntVar(&cfg.WritePercent, "write-percent", 20, "mixed mode write percentage")
	flag.StringVar(&cfg.QueryPattern, "query-pattern", "self", "self|hot|random")
	flag.StringVar(&cfg.ManifestPath, "manifest", "", "path to benchervs manifest")
	flag.StringVar(&cfg.Prefix, "prefix", "", "dataset prefix")
	flag.IntVar(&cfg.HotsetSize, "hotset-size", 100, "hot pattern hotset size")
	flag.IntVar(&cfg.TimeoutSec, "timeout-sec", 30, "operation timeout seconds")
	flag.BoolVar(&cfg.OutputJSON, "json", false, "emit JSON report")
	flag.Parse()
	return cfg
}

func run(cfg runnerConfig) error {
	vectorCfg, err := resolveVectorConfig(cfg)
	if err != nil {
		return err
	}
	if cfg.VectorSize <= 0 {
		cfg.VectorSize = vectorCfg.VectorSize
	}
	if cfg.VectorSize <= 0 {
		return errors.New("vector size must be > 0")
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 1
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 1
	}
	if cfg.TopK <= 0 {
		cfg.TopK = 1
	}
	if cfg.TimeoutSec <= 0 {
		cfg.TimeoutSec = 30
	}
	if cfg.Prefix == "" {
		cfg.Prefix = fmt.Sprintf("benchervs-%d", time.Now().Unix())
	}
	if cfg.Label == "" {
		cfg.Label = strings.ToLower(strings.TrimSpace(vectorCfg.Provider))
		if cfg.Label == "" {
			cfg.Label = "pgvector"
		}
	}
	cfg.Provider = strings.ToLower(strings.TrimSpace(vectorCfg.Provider))
	if cfg.Provider == "" {
		cfg.Provider = "pgvector"
	}

	adapter, err := infra.ResolveVectorAdapter(vectorCfg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSec)*time.Second)
	defer cancel()
	if err := adapter.Health(ctx); err != nil {
		return fmt.Errorf("vector backend health failed: %w", err)
	}

	switch strings.ToLower(strings.TrimSpace(cfg.Mode)) {
	case "run":
		mf, insertReport, err := runSeed(adapter, cfg)
		if err != nil {
			return err
		}
		searchReport, err := runQuery(adapter, cfg, mf)
		if err != nil {
			return err
		}
		return printRunReport(runReport{
			Label:    cfg.Label,
			Provider: cfg.Provider,
			Insert:   insertReport,
			Search:   searchReport,
		}, cfg.OutputJSON)
	case "insert", "seed":
		mf, report, err := runSeed(adapter, cfg)
		if err != nil {
			return err
		}
		if cfg.ManifestPath != "" {
			if err := writeManifest(cfg.ManifestPath, mf); err != nil {
				return err
			}
		}
		return printReport(report, cfg.OutputJSON)
	case "query":
		mf, err := loadOrBuildManifest(cfg, vectorCfg.Provider)
		if err != nil {
			return err
		}
		report, err := runQuery(adapter, cfg, mf)
		if err != nil {
			return err
		}
		return printReport(report, cfg.OutputJSON)
	case "mixed":
		report, err := runMixed(adapter, cfg, vectorCfg.Provider)
		if err != nil {
			return err
		}
		return printReport(report, cfg.OutputJSON)
	default:
		return fmt.Errorf("unsupported mode: %s", cfg.Mode)
	}
}

func resolveVectorConfig(cfg runnerConfig) (infra.VectorIndexConfig, error) {
	if strings.TrimSpace(cfg.ConfigPath) != "" {
		serverCfg, err := config.LoadStorageServerConfigFromPath(cfg.ConfigPath)
		if err != nil {
			return infra.VectorIndexConfig{}, err
		}
		return serverCfg.VectorIndex, nil
	}
	provider := strings.ToLower(strings.TrimSpace(cfg.BackendType))
	if provider == "" {
		return infra.VectorIndexConfig{}, errors.New("either -config or -type is required")
	}
	vectorCfg := infra.VectorIndexConfig{
		Provider:      provider,
		ConnStr:       strings.TrimSpace(cfg.DSN),
		Schema:        strings.TrimSpace(cfg.Schema),
		Table:         strings.TrimSpace(cfg.Table),
		IndexName:     strings.TrimSpace(cfg.IndexName),
		EndpointURL:   strings.TrimSpace(cfg.Endpoint),
		APIKey:        strings.TrimSpace(cfg.APIKey),
		Collection:    strings.TrimSpace(cfg.Collection),
		Distance:      strings.TrimSpace(cfg.Distance),
		VectorSize:    cfg.VectorSize,
		SearchTopSize: cfg.SearchTopSize,
		TimeoutSec:    cfg.TimeoutSec,
	}
	applyVectorDefaults(&vectorCfg)
	if err := validateVectorConfig(vectorCfg); err != nil {
		return infra.VectorIndexConfig{}, err
	}
	return vectorCfg, nil
}

func applyVectorDefaults(cfg *infra.VectorIndexConfig) {
	if cfg == nil {
		return
	}
	switch cfg.Provider {
	case "pgvector", "postgres":
		if cfg.Schema == "" {
			cfg.Schema = "public"
		}
		if cfg.Table == "" {
			cfg.Table = "image_embeddings"
		}
	case "qdrant":
		if cfg.EndpointURL == "" {
			cfg.EndpointURL = "http://localhost:6333"
		}
		if cfg.Collection == "" {
			if cfg.Table != "" {
				cfg.Collection = cfg.Table
			} else {
				cfg.Collection = "image_embeddings"
			}
		}
		if cfg.Table == "" {
			cfg.Table = cfg.Collection
		}
	case "milvus":
		if cfg.EndpointURL == "" {
			cfg.EndpointURL = "http://localhost:19530"
		}
		if cfg.Schema == "" {
			cfg.Schema = "default"
		}
		if cfg.Collection == "" {
			if cfg.Table != "" {
				cfg.Collection = cfg.Table
			} else {
				cfg.Collection = "image_embeddings"
			}
		}
		if cfg.Table == "" {
			cfg.Table = cfg.Collection
		}
	}
}

func validateVectorConfig(cfg infra.VectorIndexConfig) error {
	switch cfg.Provider {
	case "pgvector", "postgres":
		if cfg.ConnStr == "" {
			return errors.New("pgvector requires -dsn")
		}
	case "qdrant":
		if cfg.EndpointURL == "" {
			return errors.New("qdrant requires -endpoint")
		}
	case "milvus":
		if cfg.EndpointURL == "" {
			return errors.New("milvus requires -endpoint")
		}
	default:
		return fmt.Errorf("unsupported vector backend type: %s", cfg.Provider)
	}
	return nil
}

func runSeed(adapter infra.VectorAdapter, cfg runnerConfig) (manifest, benchReport, error) {
	start := time.Now()
	stats := &benchStats{}
	mf := manifest{
		Label:      cfg.Label,
		Provider:   cfg.Provider,
		Prefix:     cfg.Prefix,
		Count:      cfg.SeedCount,
		VectorSize: cfg.VectorSize,
		Seed:       cfg.Seed,
	}
	if cfg.SeedCount <= 0 {
		return mf, benchReport{}, errors.New("seed-count must be > 0")
	}
	if batch, ok := adapter.(vectorBatchUpserter); ok {
		for startIdx := 0; startIdx < cfg.SeedCount; startIdx += cfg.BatchSize {
			endIdx := minInt(startIdx+cfg.BatchSize, cfg.SeedCount)
			ids := make([]string, 0, endIdx-startIdx)
			vectors := make([][]float64, 0, endIdx-startIdx)
			t0 := time.Now()
			for i := startIdx; i < endIdx; i++ {
				ids = append(ids, benchObjectID(cfg.Provider, cfg.Prefix, i))
				vectors = append(vectors, deterministicVector(cfg.Seed, i, cfg.VectorSize))
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSec)*time.Second)
			err := batch.UpsertBatch(ctx, ids, vectors)
			cancel()
			recordOutcomeN(stats, time.Since(t0), err, len(ids))
			if err != nil {
				return mf, buildReport(cfg, stats, time.Since(start), ""), err
			}
		}
	} else {
		for i := 0; i < cfg.SeedCount; i++ {
			t0 := time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSec)*time.Second)
			err := adapter.Upsert(ctx, benchObjectID(cfg.Provider, cfg.Prefix, i), deterministicVector(cfg.Seed, i, cfg.VectorSize))
			cancel()
			recordOutcome(stats, time.Since(t0), err)
			if err != nil {
				return mf, buildReport(cfg, stats, time.Since(start), ""), err
			}
		}
	}
	return mf, buildReport(cfg, stats, time.Since(start), ""), nil
}

func runQuery(adapter infra.VectorAdapter, cfg runnerConfig, mf manifest) (benchReport, error) {
	if cfg.QueryCount <= 0 {
		return benchReport{}, errors.New("query-count must be > 0")
	}
	start := time.Now()
	stats := &benchStats{}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < cfg.Concurrency; worker++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(cfg.Seed + int64(workerID)*7919))
			for n := range jobs {
				queryVec := makeQueryVector(cfg, mf, rng, n)
				t0 := time.Now()
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSec)*time.Second)
				_, err := adapter.QueryTopK(ctx, queryVec, cfg.TopK)
				cancel()
				recordOutcome(stats, time.Since(t0), err)
			}
		}(worker)
	}
	for i := 0; i < cfg.QueryCount; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return buildReport(cfg, stats, time.Since(start), cfg.QueryPattern), nil
}

func runMixed(adapter infra.VectorAdapter, cfg runnerConfig, provider string) (benchReport, error) {
	if cfg.MixedOps <= 0 {
		return benchReport{}, errors.New("mixed-ops must be > 0")
	}
	if cfg.WritePercent < 0 || cfg.WritePercent > 100 {
		return benchReport{}, errors.New("write-percent must be between 0 and 100")
	}
	start := time.Now()
	stats := &benchStats{}
	var inserted atomic.Int64
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < cfg.Concurrency; worker++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(cfg.Seed + int64(workerID)*6151))
			for opIndex := range jobs {
				writeOp := rng.Intn(100) < cfg.WritePercent
				t0 := time.Now()
				var err error
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSec)*time.Second)
				if writeOp {
					index := int(inserted.Add(1) - 1)
					err = adapter.Upsert(ctx, benchObjectID(cfg.Provider, cfg.Prefix, index), deterministicVector(cfg.Seed, index, cfg.VectorSize))
				} else {
					maxInserted := int(inserted.Load())
					queryVec := mixedQueryVector(cfg, rng, maxInserted, opIndex)
					_, err = adapter.QueryTopK(ctx, queryVec, cfg.TopK)
				}
				cancel()
				recordOutcome(stats, time.Since(t0), err)
			}
		}(worker)
	}
	for i := 0; i < cfg.MixedOps; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return buildReport(runnerConfig{
		Label:    cfg.Label,
		Provider: cfg.Provider,
		Mode:     "mixed",
	}, stats, time.Since(start), fmt.Sprintf("%s:%d%%write", provider, cfg.WritePercent)), nil
}

func loadOrBuildManifest(cfg runnerConfig, provider string) (manifest, error) {
	if cfg.ManifestPath != "" {
		return readManifest(cfg.ManifestPath)
	}
	if cfg.SeedCount <= 0 {
		return manifest{}, errors.New("seed-count or manifest is required for query mode")
	}
	return manifest{
		Label:      cfg.Label,
		Provider:   provider,
		Prefix:     cfg.Prefix,
		Count:      cfg.SeedCount,
		VectorSize: cfg.VectorSize,
		Seed:       cfg.Seed,
	}, nil
}

func benchObjectID(provider, prefix string, index int) string {
	base := fmt.Sprintf("%s-%09d", prefix, index)
	if strings.EqualFold(strings.TrimSpace(provider), "qdrant") {
		sum := sha1.Sum([]byte(base))
		raw := sum[:16]
		raw[6] = (raw[6] & 0x0f) | 0x50
		raw[8] = (raw[8] & 0x3f) | 0x80
		return fmt.Sprintf(
			"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
			raw[0], raw[1], raw[2], raw[3],
			raw[4], raw[5],
			raw[6], raw[7],
			raw[8], raw[9],
			raw[10], raw[11], raw[12], raw[13], raw[14], raw[15],
		)
	}
	return base
}

func deterministicVector(seed int64, index, dim int) []float64 {
	rng := rand.New(rand.NewSource(seed + int64(index)*104729))
	out := make([]float64, dim)
	var norm float64
	for i := range out {
		v := rng.Float64()*2 - 1
		out[i] = v
		norm += v * v
	}
	if norm == 0 {
		out[0] = 1
		return out
	}
	scale := 1 / math.Sqrt(norm)
	for i := range out {
		out[i] *= scale
	}
	return out
}

func makeQueryVector(cfg runnerConfig, mf manifest, rng *rand.Rand, opIndex int) []float64 {
	switch strings.ToLower(strings.TrimSpace(cfg.QueryPattern)) {
	case "random":
		return deterministicVector(cfg.Seed+int64(opIndex)+9001, opIndex, mf.VectorSize)
	case "hot":
		limit := minInt(maxInt(cfg.HotsetSize, 1), maxInt(mf.Count, 1))
		return deterministicVector(mf.Seed, rng.Intn(limit), mf.VectorSize)
	case "self":
		fallthrough
	default:
		limit := maxInt(mf.Count, 1)
		return deterministicVector(mf.Seed, rng.Intn(limit), mf.VectorSize)
	}
}

func mixedQueryVector(cfg runnerConfig, rng *rand.Rand, maxInserted, opIndex int) []float64 {
	if maxInserted <= 0 {
		return deterministicVector(cfg.Seed+int64(opIndex)+17011, opIndex, cfg.VectorSize)
	}
	limit := maxInserted
	if strings.EqualFold(cfg.QueryPattern, "hot") {
		limit = minInt(limit, maxInt(cfg.HotsetSize, 1))
	}
	return deterministicVector(cfg.Seed, rng.Intn(limit), cfg.VectorSize)
}

func recordOutcome(stats *benchStats, d time.Duration, err error) {
	recordOutcomeN(stats, d, err, 1)
}

func recordOutcomeN(stats *benchStats, d time.Duration, err error, n int) {
	if n <= 0 {
		n = 1
	}
	if err != nil {
		atomic.AddInt64(&stats.Errors, int64(n))
		return
	}
	atomic.AddInt64(&stats.Successes, int64(n))
	msPerOp := (float64(d) / float64(time.Millisecond)) / float64(n)
	for i := 0; i < n; i++ {
		appendLatency(stats, msPerOp)
	}
}

func appendLatency(stats *benchStats, v float64) {
	stats.mu.Lock()
	stats.Latencies = append(stats.Latencies, v)
	stats.mu.Unlock()
}

func buildReport(cfg runnerConfig, stats *benchStats, elapsed time.Duration, queryPattern string) benchReport {
	latencies := append([]float64(nil), stats.Latencies...)
	sort.Float64s(latencies)
	total := atomic.LoadInt64(&stats.Successes) + atomic.LoadInt64(&stats.Errors)
	report := benchReport{
		Label:        cfg.Label,
		Mode:         cfg.Mode,
		Provider:     cfg.Provider,
		QueryPattern: queryPattern,
		Operations:   total,
		Errors:       atomic.LoadInt64(&stats.Errors),
		DurationSec:  elapsed.Seconds(),
	}
	if elapsed > 0 {
		report.ThroughputOpsSec = float64(total) / elapsed.Seconds()
	}
	if len(latencies) == 0 {
		return report
	}
	report.MinMs = latencies[0]
	report.MaxMs = latencies[len(latencies)-1]
	report.AvgMs = average(latencies)
	report.P50Ms = percentile(latencies, 0.50)
	report.P95Ms = percentile(latencies, 0.95)
	report.P99Ms = percentile(latencies, 0.99)
	return report
}

func average(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	var total float64
	for _, v := range values {
		total += v
	}
	return total / float64(len(values))
}

func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	if p <= 0 {
		return values[0]
	}
	if p >= 1 {
		return values[len(values)-1]
	}
	idx := int(math.Ceil(float64(len(values))*p)) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(values) {
		idx = len(values) - 1
	}
	return values[idx]
}

func writeManifest(path string, mf manifest) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func readManifest(path string) (manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return manifest{}, err
	}
	var mf manifest
	if err := json.Unmarshal(raw, &mf); err != nil {
		return manifest{}, err
	}
	if mf.Count <= 0 || mf.VectorSize <= 0 {
		return manifest{}, errors.New("invalid manifest")
	}
	return mf, nil
}

func printReport(report benchReport, outputJSON bool) error {
	if outputJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Printf("benchervs report\n")
	fmt.Printf("  label: %s\n", report.Label)
	fmt.Printf("  mode: %s\n", report.Mode)
	fmt.Printf("  provider: %s\n", report.Provider)
	if report.QueryPattern != "" {
		fmt.Printf("  query_pattern: %s\n", report.QueryPattern)
	}
	fmt.Printf("  operations: %d\n", report.Operations)
	fmt.Printf("  errors: %d\n", report.Errors)
	fmt.Printf("  duration_sec: %.3f\n", report.DurationSec)
	fmt.Printf("  throughput_ops_sec: %.2f\n", report.ThroughputOpsSec)
	fmt.Printf("  avg_ms: %.3f\n", report.AvgMs)
	fmt.Printf("  p50_ms: %.3f\n", report.P50Ms)
	fmt.Printf("  p95_ms: %.3f\n", report.P95Ms)
	fmt.Printf("  p99_ms: %.3f\n", report.P99Ms)
	fmt.Printf("  min_ms: %.3f\n", report.MinMs)
	fmt.Printf("  max_ms: %.3f\n", report.MaxMs)
	return nil
}

func printRunReport(report runReport, outputJSON bool) error {
	if outputJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Printf("benchervs run\n")
	fmt.Printf("  label: %s\n", report.Label)
	fmt.Printf("  provider: %s\n", report.Provider)
	fmt.Printf("insert:\n")
	printIndentedBenchReport(report.Insert)
	fmt.Printf("search:\n")
	printIndentedBenchReport(report.Search)
	return nil
}

func printIndentedBenchReport(report benchReport) {
	fmt.Printf("  mode: %s\n", report.Mode)
	if report.QueryPattern != "" {
		fmt.Printf("  query_pattern: %s\n", report.QueryPattern)
	}
	fmt.Printf("  operations: %d\n", report.Operations)
	fmt.Printf("  errors: %d\n", report.Errors)
	fmt.Printf("  duration_sec: %.3f\n", report.DurationSec)
	fmt.Printf("  throughput_ops_sec: %.2f\n", report.ThroughputOpsSec)
	fmt.Printf("  avg_ms: %.3f\n", report.AvgMs)
	fmt.Printf("  p50_ms: %.3f\n", report.P50Ms)
	fmt.Printf("  p95_ms: %.3f\n", report.P95Ms)
	fmt.Printf("  p99_ms: %.3f\n", report.P99Ms)
	fmt.Printf("  min_ms: %.3f\n", report.MinMs)
	fmt.Printf("  max_ms: %.3f\n", report.MaxMs)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

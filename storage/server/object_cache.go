package server

import (
	"container/list"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type ObjectCacheConfig struct {
	Enabled            bool
	MaxItems           int
	MaxTotalBytes      int64
	MaxObjectSizeBytes int64
	TTL                time.Duration
}

type cacheValue struct {
	Content     []byte
	ContentType string
	SizeBytes   int64
}

type cacheEntry struct {
	objectID    string
	content     []byte
	contentType string
	sizeBytes   int64
	expiresAt   time.Time
}

type ObjectCache struct {
	mu                 sync.Mutex
	maxItems           int
	maxTotalBytes      int64
	maxObjectSizeBytes int64
	ttl                time.Duration
	totalBytes         int64
	order              *list.List
	entries            map[string]*list.Element

	hits      atomic.Uint64
	misses    atomic.Uint64
	evictions atomic.Uint64
}

func NewObjectCache(cfg ObjectCacheConfig) *ObjectCache {
	if !cfg.Enabled {
		return nil
	}
	maxItems := cfg.MaxItems
	if maxItems <= 0 {
		maxItems = 1000
	}
	maxTotalBytes := cfg.MaxTotalBytes
	if maxTotalBytes <= 0 {
		maxTotalBytes = 256 * 1024 * 1024
	}
	maxObjectSizeBytes := cfg.MaxObjectSizeBytes
	if maxObjectSizeBytes <= 0 {
		maxObjectSizeBytes = 8 * 1024 * 1024
	}
	registerObjectCacheMetrics()
	return &ObjectCache{
		maxItems:           maxItems,
		maxTotalBytes:      maxTotalBytes,
		maxObjectSizeBytes: maxObjectSizeBytes,
		ttl:                cfg.TTL,
		order:              list.New(),
		entries:            make(map[string]*list.Element, maxItems),
	}
}

func (c *ObjectCache) Get(objectID string) (cacheValue, bool) {
	if c == nil {
		return cacheValue{}, false
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.entries[objectID]
	if !ok {
		c.misses.Add(1)
		objectCacheMisses.Inc()
		return cacheValue{}, false
	}
	entry := elem.Value.(*cacheEntry)
	if !entry.expiresAt.IsZero() && now.After(entry.expiresAt) {
		c.removeElem(elem, "expired")
		c.misses.Add(1)
		objectCacheMisses.Inc()
		return cacheValue{}, false
	}
	c.order.MoveToFront(elem)
	c.hits.Add(1)
	objectCacheHits.Inc()
	return cacheValue{
		Content:     append([]byte(nil), entry.content...),
		ContentType: entry.contentType,
		SizeBytes:   entry.sizeBytes,
	}, true
}

func (c *ObjectCache) Put(objectID string, content []byte, contentType string) {
	if c == nil {
		return
	}
	size := int64(len(content))
	if size == 0 || (c.maxObjectSizeBytes > 0 && size > c.maxObjectSizeBytes) {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	var expiresAt time.Time
	if c.ttl > 0 {
		expiresAt = now.Add(c.ttl)
	}

	if elem, ok := c.entries[objectID]; ok {
		entry := elem.Value.(*cacheEntry)
		c.totalBytes -= entry.sizeBytes
		entry.content = append([]byte(nil), content...)
		entry.contentType = contentType
		entry.sizeBytes = size
		entry.expiresAt = expiresAt
		c.totalBytes += size
		c.order.MoveToFront(elem)
	} else {
		entry := &cacheEntry{
			objectID:    objectID,
			content:     append([]byte(nil), content...),
			contentType: contentType,
			sizeBytes:   size,
			expiresAt:   expiresAt,
		}
		elem := c.order.PushFront(entry)
		c.entries[objectID] = elem
		c.totalBytes += size
	}
	c.evictIfNeeded()
	c.updateGaugesLocked()
}

func (c *ObjectCache) Delete(objectID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.entries[objectID]; ok {
		c.removeElem(elem, "")
		c.updateGaugesLocked()
	}
}

func (c *ObjectCache) evictIfNeeded() {
	for {
		overItems := c.maxItems > 0 && len(c.entries) > c.maxItems
		overBytes := c.maxTotalBytes > 0 && c.totalBytes > c.maxTotalBytes
		if !overItems && !overBytes {
			break
		}
		back := c.order.Back()
		if back == nil {
			break
		}
		c.removeElem(back, "capacity")
	}
}

func (c *ObjectCache) removeElem(elem *list.Element, reason string) {
	entry := elem.Value.(*cacheEntry)
	delete(c.entries, entry.objectID)
	c.order.Remove(elem)
	c.totalBytes -= entry.sizeBytes
	if c.totalBytes < 0 {
		c.totalBytes = 0
	}
	if reason != "" {
		c.evictions.Add(1)
		objectCacheEvictions.WithLabelValues(reason).Inc()
	}
}

func (c *ObjectCache) updateGaugesLocked() {
	objectCacheItems.Set(float64(len(c.entries)))
	objectCacheBytes.Set(float64(c.totalBytes))
}

var (
	objectCacheMetricsOnce sync.Once
	objectCacheHits        prometheus.Counter
	objectCacheMisses      prometheus.Counter
	objectCacheEvictions   *prometheus.CounterVec
	objectCacheItems       prometheus.Gauge
	objectCacheBytes       prometheus.Gauge
)

func registerObjectCacheMetrics() {
	objectCacheMetricsOnce.Do(func() {
		objectCacheHits = prometheus.NewCounter(prometheus.CounterOpts{
			Name: "avsp_storage_object_cache_hits_total",
			Help: "Total object cache hits.",
		})
		objectCacheMisses = prometheus.NewCounter(prometheus.CounterOpts{
			Name: "avsp_storage_object_cache_misses_total",
			Help: "Total object cache misses.",
		})
		objectCacheEvictions = prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "avsp_storage_object_cache_evictions_total",
			Help: "Total object cache evictions by reason.",
		}, []string{"reason"})
		objectCacheItems = prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "avsp_storage_object_cache_items",
			Help: "Current number of cached objects.",
		})
		objectCacheBytes = prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "avsp_storage_object_cache_bytes",
			Help: "Current memory usage of object cache in bytes.",
		})
		prometheus.MustRegister(objectCacheHits, objectCacheMisses, objectCacheEvictions, objectCacheItems, objectCacheBytes)
	})
}

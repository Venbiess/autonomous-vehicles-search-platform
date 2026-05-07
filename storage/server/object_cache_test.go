package server

import (
	"bytes"
	"testing"
	"time"
)

func TestNewObjectCacheDisabledReturnsNil(t *testing.T) {
	if NewObjectCache(ObjectCacheConfig{Enabled: false}) != nil {
		t.Fatal("expected nil cache when disabled")
	}
}

func TestObjectCachePutGetReturnsCopy(t *testing.T) {
	cache := NewObjectCache(ObjectCacheConfig{Enabled: true, MaxItems: 10, MaxTotalBytes: 1024})
	cache.Put("obj-1", []byte("payload"), "image/jpeg")

	got, ok := cache.Get("obj-1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if got.ContentType != "image/jpeg" {
		t.Fatalf("unexpected content type: %q", got.ContentType)
	}
	got.Content[0] = 'X'

	gotAgain, ok := cache.Get("obj-1")
	if !ok {
		t.Fatal("expected second cache hit")
	}
	if bytes.Equal(got.Content, gotAgain.Content) {
		t.Fatal("expected defensive copy from cache")
	}
}

func TestObjectCacheTTLExpiresEntries(t *testing.T) {
	cache := NewObjectCache(ObjectCacheConfig{
		Enabled:       true,
		MaxItems:      10,
		MaxTotalBytes: 1024,
		TTL:           5 * time.Millisecond,
	})
	cache.Put("obj-1", []byte("payload"), "text/plain")
	time.Sleep(15 * time.Millisecond)

	if _, ok := cache.Get("obj-1"); ok {
		t.Fatal("expected expired cache entry to miss")
	}
}

func TestObjectCacheEvictsOnCapacity(t *testing.T) {
	cache := NewObjectCache(ObjectCacheConfig{
		Enabled:       true,
		MaxItems:      1,
		MaxTotalBytes: 1024,
	})
	cache.Put("obj-1", []byte("one"), "text/plain")
	cache.Put("obj-2", []byte("two"), "text/plain")

	if _, ok := cache.Get("obj-1"); ok {
		t.Fatal("expected oldest item to be evicted")
	}
	if _, ok := cache.Get("obj-2"); !ok {
		t.Fatal("expected newest item to remain")
	}
}

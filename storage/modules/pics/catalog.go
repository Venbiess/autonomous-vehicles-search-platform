package images

import (
	"context"
	"container/list"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"sync/atomic"

	"github.com/dgraph-io/badger/v4"
)

type objectRecord struct {
	Bucket    string        `json:"bucket"`
	Key       string        `json:"key"`
	BlobID    string        `json:"blob_id"`
	Metadata  ImageMetadata `json:"metadata"`
	UpdatedAt time.Time     `json:"updated_at"`
}

type objectCacheKey struct {
	bucket string
	key    string
}

type objectCacheValue struct {
	key    objectCacheKey
	record objectRecord
}

type objectCache struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
	items    map[objectCacheKey]*list.Element
}

func newObjectCache(capacity int) *objectCache {
	if capacity <= 0 {
		capacity = 1
	}
	return &objectCache{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[objectCacheKey]*list.Element, capacity),
	}
}

func (c *objectCache) Get(bucket, key string) (objectRecord, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cacheKey := objectCacheKey{bucket: bucket, key: key}
	elem, ok := c.items[cacheKey]
	if !ok {
		return objectRecord{}, false
	}
	c.ll.MoveToFront(elem)
	return elem.Value.(objectCacheValue).record, true
}

func (c *objectCache) Put(record objectRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cacheKey := objectCacheKey{bucket: record.Bucket, key: record.Key}
	if elem, ok := c.items[cacheKey]; ok {
		elem.Value = objectCacheValue{key: cacheKey, record: record}
		c.ll.MoveToFront(elem)
		return
	}
	elem := c.ll.PushFront(objectCacheValue{key: cacheKey, record: record})
	c.items[cacheKey] = elem
	if c.ll.Len() <= c.capacity {
		return
	}
	tail := c.ll.Back()
	if tail == nil {
		return
	}
	evicted := tail.Value.(objectCacheValue)
	delete(c.items, evicted.key)
	c.ll.Remove(tail)
}

func (c *objectCache) Delete(bucket, key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cacheKey := objectCacheKey{bucket: bucket, key: key}
	elem, ok := c.items[cacheKey]
	if !ok {
		return
	}
	delete(c.items, cacheKey)
	c.ll.Remove(elem)
}

func (r *Registry) GetObject(bucket, key string) (*objectRecord, error) {
	if record, ok := r.objectCache.Get(bucket, key); ok {
		copyRecord := record
		return &copyRecord, nil
	}

	var out objectRecord
	err := r.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get(objectKey(bucket, key))
		if err != nil {
			return err
		}
		raw, err := item.ValueCopy(nil)
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, &out)
	})
	if err != nil {
		if err == badger.ErrKeyNotFound {
			return nil, nil
		}
		return nil, err
	}
	r.objectCache.Put(out)
	return &out, nil
}

func (r *Registry) DeleteObject(bucket, key string) (*objectRecord, error) {
	var previous *objectRecord
	err := r.db.Update(func(txn *badger.Txn) error {
		item, err := txn.Get(objectKey(bucket, key))
		if err != nil {
			if err == badger.ErrKeyNotFound {
				return nil
			}
			return err
		}
		raw, err := item.ValueCopy(nil)
		if err != nil {
			return err
		}
		var old objectRecord
		if err := json.Unmarshal(raw, &old); err != nil {
			return err
		}
		previous = &old
		return txn.Delete(objectKey(bucket, key))
	})
	if err != nil {
		return nil, err
	}
	r.objectCache.Delete(bucket, key)
	return previous, nil
}

func (r *Registry) DeleteObjectSync(ctx context.Context, bucket, key string) (*objectRecord, error) {
	record, err := r.GetObject(bucket, key)
	if err != nil || record == nil {
		return record, err
	}
	blobID, err := ParseBlobID(record.BlobID)
	if err != nil {
		return nil, err
	}

	r.mu.RLock()
	pack, ok := r.packs[blobID.PackID]
	replicas := make([]Replica, 0)
	if ok {
		replicas = append(replicas, pack.Replicas...)
	}
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("pack not found")
	}
	req := EntryDeleteRequest{EntryID: blobID.EntryID, Guard: blobID.Guard}
	var failed atomic.Int32
	errs := make(chan error, len(replicas))
	var wg sync.WaitGroup
	for _, replica := range replicas {
		replica := replica
		wg.Add(1)
		go func() {
			defer wg.Done()
			if replica.URL == "" {
				failed.Add(1)
				errs <- fmt.Errorf("replica %s has empty url", replica.ServerID)
				return
			}
			endpoint := fmt.Sprintf(
				"%s/internal/packs/%d/delete",
				strings.TrimRight(replica.URL, "/"),
				blobID.PackID,
			)
			if err := postJSON(r.client, ctx, endpoint, req, nil); err != nil {
				failed.Add(1)
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	if failed.Load() > 0 {
		first := <-errs
		return nil, fmt.Errorf("delete failed on %d/%d replicas: %w", failed.Load(), len(replicas), first)
	}

	return r.DeleteObject(bucket, key)
}

func (r *Registry) ListObjects(bucket, start string, limit int) ([]objectRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	records := make([]objectRecord, 0, limit)
	err := r.db.View(func(txn *badger.Txn) error {
		iter := txn.NewIterator(badger.DefaultIteratorOptions)
		defer iter.Close()
		bucketPrefix := objectBucketPrefix(bucket)
		seekKey := objectStartKey(bucket, start)
		for iter.Seek(seekKey); iter.ValidForPrefix(bucketPrefix); iter.Next() {
			item := iter.Item()
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			var record objectRecord
			if err := json.Unmarshal(raw, &record); err != nil {
				return err
			}
			records = append(records, record)
			if len(records) >= limit {
				break
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return records, nil
}

func objectKey(bucket, key string) []byte {
	return []byte("object/" + bucket + "\x00" + key)
}

func objectBucketPrefix(bucket string) []byte {
	return []byte("object/" + bucket + "\x00")
}

func objectStartKey(bucket, start string) []byte {
	return []byte("object/" + bucket + "\x00" + start)
}

func normalizeObjectPath(raw string) string {
	return strings.TrimPrefix(raw, "/")
}

func objectURL(bucket, key string) string {
	return "/b/" + bucket + "/" + key
}

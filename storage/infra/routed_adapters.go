package infra

import (
	"context"
	"errors"
	"sort"
	"sync"
)

type MultiObjectAdapter struct {
	adapters []ObjectAdapter
}

func NewMultiObjectAdapter(adapters []ObjectAdapter) (*MultiObjectAdapter, error) {
	if len(adapters) == 0 {
		return nil, errors.New("at least one object adapter is required")
	}
	return &MultiObjectAdapter{adapters: adapters}, nil
}

func (m *MultiObjectAdapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	idx := shardIndex(bucket+":"+key, len(m.adapters))
	return m.adapters[idx].GetBytes(ctx, bucket, key)
}

func (m *MultiObjectAdapter) HeadObject(ctx context.Context, bucket, key string) (ObjectInfo, error) {
	idx := shardIndex(bucket+":"+key, len(m.adapters))
	return m.adapters[idx].HeadObject(ctx, bucket, key)
}

func (m *MultiObjectAdapter) PutBytes(ctx context.Context, bucket, key string, data []byte, contentType string) (PutResult, error) {
	idx := shardIndex(bucket+":"+key, len(m.adapters))
	return m.adapters[idx].PutBytes(ctx, bucket, key, data, contentType)
}

func (m *MultiObjectAdapter) Delete(ctx context.Context, bucket, key string) error {
	idx := shardIndex(bucket+":"+key, len(m.adapters))
	return m.adapters[idx].Delete(ctx, bucket, key)
}

func (m *MultiObjectAdapter) Health(ctx context.Context) error {
	return firstErrorParallel(len(m.adapters), func(i int) error {
		return m.adapters[i].Health(ctx)
	})
}

type MultiVectorAdapter struct {
	adapters []VectorAdapter
}

func NewMultiVectorAdapter(adapters []VectorAdapter) (*MultiVectorAdapter, error) {
	if len(adapters) == 0 {
		return nil, errors.New("at least one vector adapter is required")
	}
	return &MultiVectorAdapter{adapters: adapters}, nil
}

func (m *MultiVectorAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	idx := shardIndex(objectID, len(m.adapters))
	return m.adapters[idx].Upsert(ctx, objectID, embedding)
}

func (m *MultiVectorAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error) {
	type shardResult struct {
		items []VectorQueryResult
		err   error
	}
	out := make([]shardResult, len(m.adapters))
	var wg sync.WaitGroup
	wg.Add(len(m.adapters))
	for i := range m.adapters {
		go func(i int) {
			defer wg.Done()
			items, err := m.adapters[i].QueryTopK(ctx, embedding, topK)
			out[i] = shardResult{items: items, err: err}
		}(i)
	}
	wg.Wait()
	for _, item := range out {
		if item.err != nil {
			return nil, item.err
		}
	}
	merged := make([]VectorQueryResult, 0, len(m.adapters)*topK)
	for _, item := range out {
		merged = append(merged, item.items...)
	}
	sort.Slice(merged, func(i, j int) bool {
		return merged[i].Distance < merged[j].Distance
	})
	if topK > 0 && len(merged) > topK {
		merged = merged[:topK]
	}
	return merged, nil
}

func (m *MultiVectorAdapter) Delete(ctx context.Context, objectIDs []string) error {
	grouped := make([][]string, len(m.adapters))
	for _, objectID := range objectIDs {
		idx := shardIndex(objectID, len(m.adapters))
		grouped[idx] = append(grouped[idx], objectID)
	}
	return firstErrorParallel(len(m.adapters), func(i int) error {
		if len(grouped[i]) == 0 {
			return nil
		}
		return m.adapters[i].Delete(ctx, grouped[i])
	})
}

func (m *MultiVectorAdapter) Health(ctx context.Context) error {
	return firstErrorParallel(len(m.adapters), func(i int) error {
		return m.adapters[i].Health(ctx)
	})
}

func firstErrorParallel(total int, fn func(i int) error) error {
	var (
		wg      sync.WaitGroup
		errOnce sync.Once
		first   error
	)
	wg.Add(total)
	for i := 0; i < total; i++ {
		go func(i int) {
			defer wg.Done()
			if err := fn(i); err != nil {
				errOnce.Do(func() { first = err })
			}
		}(i)
	}
	wg.Wait()
	return first
}

func shardIndex(key string, shards int) int {
	if shards <= 1 {
		return 0
	}
	var h uint32 = 2166136261
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= 16777619
	}
	return int(h % uint32(shards))
}

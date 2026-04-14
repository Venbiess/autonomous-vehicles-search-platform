package server

import (
	"context"

	infra "avsp/storage/infra"
)

type VectorServer struct {
	adapter infra.VectorAdapter
}

func NewVectorServer(adapter infra.VectorAdapter) *VectorServer {
	return &VectorServer{adapter: adapter}
}

func (s *VectorServer) Health(ctx context.Context) error { return s.adapter.Health(ctx) }

func (s *VectorServer) Upsert(ctx context.Context, vectors []UpsertVector) error {
	for _, v := range vectors {
		if err := s.adapter.Upsert(ctx, v.ObjectID, v.Embedding); err != nil {
			return err
		}
	}
	return nil
}

func (s *VectorServer) Query(ctx context.Context, embedding []float64, topK int) ([]QueryResult, error) {
	results, err := s.adapter.QueryTopK(ctx, embedding, topK)
	if err != nil {
		return nil, err
	}
	out := make([]QueryResult, 0, len(results))
	for _, item := range results {
		out = append(out, QueryResult{ObjectID: item.ObjectID, Distance: item.Distance, Similarity: item.Similarity})
	}
	return out, nil
}

func (s *VectorServer) Delete(ctx context.Context, objectIDs []string) (int, error) {
	unique := dedupeNonEmpty(objectIDs)
	if len(unique) == 0 {
		return 0, nil
	}
	if err := s.adapter.Delete(ctx, unique); err != nil {
		return 0, err
	}
	return len(unique), nil
}

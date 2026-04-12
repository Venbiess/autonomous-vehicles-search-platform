package objectsvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"avsp/storage/pkg/adapters/object"
	"avsp/storage/pkg/common"
	"avsp/storage/pkg/contracts"
	"github.com/cockroachdb/pebble"
	"github.com/google/uuid"
)

type Config struct {
	DefaultBucket string
}

type Service struct {
	adapter object.ObjectAdapter
	kv      *pebble.DB
	cfg     Config
}

func New(adapter object.ObjectAdapter, kv *pebble.DB, cfg Config) *Service {
	return &Service{adapter: adapter, kv: kv, cfg: cfg}
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/objects", s.handleObjects)
	mux.HandleFunc("/objects/register-paths", s.handleRegisterPaths)
	mux.HandleFunc("/objects/resolve-path", s.handleResolvePath)
	mux.HandleFunc("/objects/", s.handleObjectByID)
}

func (s *Service) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.adapter.Health(r.Context()); err != nil {
		common.WriteError(w, http.StatusServiceUnavailable, err)
		return
	}
	common.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleObjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		limit := 100
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
		items, nextCursor, err := s.listObjects(limit, cursor)
		if err != nil {
			common.WriteError(w, http.StatusInternalServerError, err)
			return
		}
		common.WriteJSON(w, http.StatusOK, contracts.ListObjectsResponse{
			Items:      items,
			NextCursor: nextCursor,
		})
	case http.MethodPost:
		var req contracts.PutObjectRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			common.WriteError(w, http.StatusBadRequest, err)
			return
		}
		if strings.TrimSpace(req.StoragePath) == "" {
			common.WriteError(w, http.StatusBadRequest, errors.New("storage_path is required"))
			return
		}
		meta, err := s.resolvePath(r.Context(), req.StoragePath)
		if err != nil {
			common.WriteError(w, http.StatusInternalServerError, err)
			return
		}
		common.WriteJSON(w, http.StatusOK, contracts.PutObjectResponse{
			ObjectID:    meta.ObjectID,
			StoragePath: meta.StoragePath,
			SizeBytes:   meta.SizeBytes,
			ContentType: meta.ContentType,
			CreatedAt:   meta.CreatedAt,
		})
	default:
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (s *Service) handleRegisterPaths(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req contracts.RegisterPathsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		common.WriteError(w, http.StatusBadRequest, err)
		return
	}
	items := make([]contracts.RegisterPathItem, 0, len(req.StoragePaths))
	for _, rawPath := range req.StoragePaths {
		meta, err := s.resolvePath(r.Context(), rawPath)
		if err != nil {
			common.WriteError(w, http.StatusBadGateway, err)
			return
		}
		items = append(items, contracts.RegisterPathItem{
			ObjectID:    meta.ObjectID,
			StoragePath: meta.StoragePath,
		})
	}
	common.WriteJSON(w, http.StatusOK, contracts.RegisterPathsResponse{Items: items})
}

func (s *Service) handleResolvePath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req contracts.ResolvePathRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		common.WriteError(w, http.StatusBadRequest, err)
		return
	}
	meta, err := s.resolvePath(r.Context(), req.StoragePath)
	if err != nil {
		common.WriteError(w, http.StatusInternalServerError, err)
		return
	}
	common.WriteJSON(w, http.StatusOK, contracts.ResolvePathResponse{ObjectID: meta.ObjectID})
}

func (s *Service) handleObjectByID(w http.ResponseWriter, r *http.Request) {
	tail := strings.TrimPrefix(r.URL.Path, "/objects/")
	if tail == "" {
		common.WriteError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	parts := strings.Split(strings.Trim(tail, "/"), "/")
	objectID := parts[0]
	meta, err := s.getMetadataByID(objectID)
	if err != nil {
		common.WriteError(w, http.StatusNotFound, err)
		return
	}

	if len(parts) == 2 && parts[1] == "content" {
		if r.Method != http.MethodGet {
			common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
			return
		}
		bytes, contentType, err := s.adapter.GetBytes(r.Context(), meta.Bucket, meta.Key)
		if err != nil {
			common.WriteError(w, http.StatusBadGateway, err)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bytes)
		return
	}

	switch r.Method {
	case http.MethodGet:
		common.WriteJSON(w, http.StatusOK, meta)
	case http.MethodDelete:
		if err := s.adapter.Delete(r.Context(), meta.Bucket, meta.Key); err != nil {
			common.WriteError(w, http.StatusBadGateway, err)
			return
		}
		if err := s.deleteMetadata(meta); err != nil {
			common.WriteError(w, http.StatusInternalServerError, err)
			return
		}
		common.WriteJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (s *Service) resolvePath(ctx context.Context, storagePath string) (contracts.ObjectMetadata, error) {
	storagePath = normalizeStoragePath(storagePath)
	if storagePath == "" {
		return contracts.ObjectMetadata{}, errors.New("storage_path is required")
	}

	if meta, err := s.getMetadataByPath(storagePath); err == nil {
		return meta, nil
	}

	bucket, key, err := parseStoragePath(storagePath, s.cfg.DefaultBucket)
	if err != nil {
		return contracts.ObjectMetadata{}, err
	}
	body, contentType, err := s.adapter.GetBytes(ctx, bucket, key)
	if err != nil {
		return contracts.ObjectMetadata{}, err
	}

	meta := contracts.ObjectMetadata{
		ObjectID:    uuid.NewString(),
		StoragePath: fmt.Sprintf("s3://%s/%s", bucket, key),
		Bucket:      bucket,
		Key:         key,
		SizeBytes:   int64(len(body)),
		ContentType: contentType,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.saveMetadata(meta); err != nil {
		return contracts.ObjectMetadata{}, err
	}
	return meta, nil
}

func (s *Service) saveMetadata(meta contracts.ObjectMetadata) error {
	bytes, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if err := s.kv.Set([]byte("obj:"+meta.ObjectID), bytes, pebble.Sync); err != nil {
		return err
	}
	return s.kv.Set([]byte("path:"+meta.StoragePath), []byte(meta.ObjectID), pebble.Sync)
}

func (s *Service) deleteMetadata(meta contracts.ObjectMetadata) error {
	if err := s.kv.Delete([]byte("obj:"+meta.ObjectID), pebble.Sync); err != nil {
		return err
	}
	return s.kv.Delete([]byte("path:"+meta.StoragePath), pebble.Sync)
}

func (s *Service) getMetadataByID(objectID string) (contracts.ObjectMetadata, error) {
	val, closer, err := s.kv.Get([]byte("obj:" + objectID))
	if err != nil {
		return contracts.ObjectMetadata{}, err
	}
	defer closer.Close()
	copied := append([]byte(nil), val...)
	var meta contracts.ObjectMetadata
	if err := json.Unmarshal(copied, &meta); err != nil {
		return contracts.ObjectMetadata{}, err
	}
	return meta, nil
}

func (s *Service) getMetadataByPath(storagePath string) (contracts.ObjectMetadata, error) {
	pathKey := "path:" + storagePath
	val, closer, err := s.kv.Get([]byte(pathKey))
	if err != nil {
		return contracts.ObjectMetadata{}, err
	}
	objectID := string(append([]byte(nil), val...))
	closer.Close()
	return s.getMetadataByID(objectID)
}

func parseStoragePath(storagePath, defaultBucket string) (string, string, error) {
	path := normalizeStoragePath(storagePath)
	if strings.HasPrefix(path, "s3://") {
		path = strings.TrimPrefix(path, "s3://")
	}
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return "", "", errors.New("invalid storage path")
	}
	parts := strings.SplitN(path, "/", 2)
	if len(parts) == 1 {
		if defaultBucket == "" {
			return "", "", errors.New("default bucket is required")
		}
		return defaultBucket, parts[0], nil
	}
	return parts[0], parts[1], nil
}

func normalizeStoragePath(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\\", "/"))
}

func (s *Service) listObjects(limit int, cursor string) ([]contracts.ObjectMetadata, string, error) {
	iter, err := s.kv.NewIter(&pebble.IterOptions{
		LowerBound: []byte("obj:"),
		UpperBound: []byte("obj;"),
	})
	if err != nil {
		return nil, "", err
	}
	defer iter.Close()

	items := make([]contracts.ObjectMetadata, 0, limit)
	var nextCursor string
	for ok := iter.First(); ok; ok = iter.Next() {
		key := string(iter.Key())
		objectID := strings.TrimPrefix(key, "obj:")
		if cursor != "" && objectID <= cursor {
			continue
		}

		var meta contracts.ObjectMetadata
		if err := json.Unmarshal(iter.Value(), &meta); err != nil {
			return nil, "", err
		}
		items = append(items, meta)
		if len(items) == limit {
			nextCursor = objectID
			break
		}
	}
	return items, nextCursor, nil
}

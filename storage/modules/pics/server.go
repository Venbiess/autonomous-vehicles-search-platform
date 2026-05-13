package images

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/pprof"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func NewVolumeHandler(store *Store, cfg VolumeConfig) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/internal/packs/", func(w http.ResponseWriter, r *http.Request) {
		trimmed := strings.TrimPrefix(r.URL.Path, "/internal/packs/")
		parts := strings.Split(trimmed, "/")
		if len(parts) < 2 {
			http.NotFound(w, r)
			return
		}
		packID, err := strconv.ParseUint(parts[0], 10, 32)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "invalid pack id")
			return
		}
		action := parts[1]
		switch action {
		case "write":
			handleBinaryWrite(w, r, func(req EntryWriteRequest, body io.Reader) (ImageMetadata, error) {
				return store.Write(uint32(packID), req, body)
			})
		case "delete":
			var req EntryDeleteRequest
			if err := DecodeJSON(r, &req); err != nil {
				WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := store.Delete(uint32(packID), req); err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case "compact":
			if r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			if err := store.Compact(uint32(packID)); err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			WriteJSON(w, http.StatusOK, map[string]string{"status": "compacted"})
		case "compact-live":
			if r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			var req LiveCompactRequest
			if err := DecodeJSON(r, &req); err != nil {
				WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := store.CompactLive(uint32(packID), req.Entries); err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			WriteJSON(w, http.StatusOK, map[string]string{"status": "compacted"})
		case "repair":
			if r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			var replicas []Replica
			if err := json.NewDecoder(r.Body).Decode(&replicas); err != nil {
				WriteError(w, http.StatusBadRequest, err.Error())
				return
			}
			if err := store.RepairVolume(uint32(packID), replicas); err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			WriteJSON(w, http.StatusOK, map[string]string{"status": "repaired"})
		case "entries":
			if len(parts) != 3 {
				http.NotFound(w, r)
				return
			}
			entryID, err := strconv.ParseUint(parts[2], 10, 64)
			if err != nil {
				WriteError(w, http.StatusBadRequest, "invalid entry id")
				return
			}
			guard, err := strconv.ParseUint(r.URL.Query().Get("guard"), 10, 32)
			if err != nil {
				WriteError(w, http.StatusBadRequest, "invalid guard")
				return
			}
			item, reader, err := store.Read(uint32(packID), entryID, uint32(guard))
			if err != nil {
				if err == os.ErrNotExist {
					WriteError(w, http.StatusNotFound, "entry not found")
					return
				}
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			defer func() { _ = reader.Close() }()
			w.Header().Set("Content-Type", item.Metadata.ContentType)
			w.Header().Set("ETag", `"`+item.Metadata.Checksum+`"`)
			http.ServeContent(w, r, "", time.Unix(0, 0), reader)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/uploads/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.NotFound(w, r)
			return
		}
		uploadID := strings.TrimPrefix(r.URL.Path, "/uploads/")
		if uploadID == "" || strings.Contains(uploadID, "/") {
			http.NotFound(w, r)
			return
		}
		token := strings.TrimSpace(r.Header.Get("X-Upload-Token"))
		if token == "" {
			WriteError(w, http.StatusBadRequest, "missing X-Upload-Token")
			return
		}
		claims, err := verifyUploadToken(cfg.UploadTokenSecret, token)
		if err != nil {
			WriteError(w, http.StatusForbidden, err.Error())
			return
		}
		if claims.UploadID != uploadID {
			WriteError(w, http.StatusForbidden, "upload token does not match upload id")
			return
		}
		if claims.ServerID != cfg.ServerID {
			WriteError(w, http.StatusForbidden, "upload token is not valid for this volume")
			return
		}
		defer func() { _ = r.Body.Close() }()
		var (
			tmp     *os.File
			tmpPath string
			bodySrc io.Reader = r.Body
		)
		hasFollowers := len(claims.Replicas) > 1
		if hasFollowers {
			tmp, err = os.CreateTemp(filepath.Clean(store.cfg.DataDir), "upload-*")
			if err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			tmpPath = tmp.Name()
			defer func() {
				_ = tmp.Close()
				_ = os.Remove(tmpPath)
			}()
			bodySrc = io.TeeReader(r.Body, tmp)
		}
		metaOut, err := store.Write(claims.PackID, EntryWriteRequest{
			EntryID: claims.EntryID,
			Guard:   claims.Guard,
			Metadata: ImageMetadata{
				ContentType: claims.ContentType,
				Size:        claims.Size,
			},
		}, bodySrc)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		metadataList := make([]UploadMetadata, 0, len(claims.Replicas))
		metadataList = append(metadataList, UploadMetadata{ServerID: cfg.ServerID, Metadata: metaOut})
		req := EntryWriteRequest{
			EntryID: claims.EntryID,
			Guard:   claims.Guard,
			Metadata: ImageMetadata{
				ContentType: claims.ContentType,
				Size:        claims.Size,
			},
		}
		for _, replica := range claims.Replicas {
			if replica.ServerID == cfg.ServerID {
				continue
			}
			if _, err := tmp.Seek(0, io.SeekStart); err != nil {
				continue
			}
			followerMeta, err := postBinary(store.httpClient, replica.URL, fmt.Sprintf("/internal/packs/%d/write", claims.PackID), req, tmp, int64(claims.Size))
			if err != nil {
				continue
			}
			metadataList = append(metadataList, UploadMetadata{ServerID: replica.ServerID, Metadata: followerMeta})
		}

		completeBody, err := json.Marshal(UploadCompleteRequest{
			Token:    claims.CompleteToken,
			Metadata: metadataList,
		})
		if err != nil {
			WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		completeURL := strings.TrimRight(cfg.CoordinatorURL, "/") + "/internal/uploads/" + url.PathEscape(uploadID) + "/complete"
		completeReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, completeURL, bytes.NewReader(completeBody))
		if err != nil {
			WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		completeReq.Header.Set("Content-Type", "application/json")
		completeResp, err := store.httpClient.Do(completeReq)
		if err != nil {
			WriteError(w, http.StatusBadGateway, err.Error())
			return
		}
		defer func() { _ = completeResp.Body.Close() }()
		raw, _ := io.ReadAll(completeResp.Body)
		if completeResp.StatusCode >= 300 {
			WriteError(w, http.StatusBadGateway, strings.TrimSpace(string(raw)))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(completeResp.StatusCode)
		_, _ = w.Write(raw)
	})
	return mux
}

func handleBinaryWrite(w http.ResponseWriter, r *http.Request, fn func(req EntryWriteRequest, body io.Reader) (ImageMetadata, error)) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	meta := r.Header.Get("X-Entry-Meta")
	if meta == "" {
		WriteError(w, http.StatusBadRequest, "missing X-Entry-Meta")
		return
	}
	var req EntryWriteRequest
	if err := json.Unmarshal([]byte(meta), &req); err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer func() { _ = r.Body.Close() }()
	metaOut, err := fn(req, r.Body)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, http.StatusCreated, EntryWriteResponse{Metadata: metaOut})
}

func postBinary(client *http.Client, baseURL, path string, req EntryWriteRequest, body io.Reader, contentLength int64) (ImageMetadata, error) {
	meta, err := json.Marshal(req)
	if err != nil {
		return ImageMetadata{}, err
	}
	request, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+path, body)
	if err != nil {
		return ImageMetadata{}, err
	}
	if contentLength >= 0 {
		request.ContentLength = contentLength
	}
	request.Header.Set("X-Entry-Meta", string(meta))
	resp, err := client.Do(request)
	if err != nil {
		return ImageMetadata{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return ImageMetadata{}, fmt.Errorf("status %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	var out EntryWriteResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ImageMetadata{}, err
	}
	return out.Metadata, nil
}

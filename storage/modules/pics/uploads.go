package images

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/dgraph-io/badger/v4"
)

type signedUploadClaims struct {
	UploadID      string    `json:"upload_id"`
	ServerID      string    `json:"server_id"`
	PackID        uint32    `json:"pack_id"`
	EntryID       uint64    `json:"entry_id"`
	Guard         uint32    `json:"guard"`
	Size          uint64    `json:"size"`
	ContentType   string    `json:"content_type"`
	Replicas      []Replica `json:"replicas"`
	CompleteToken string    `json:"complete_token"`
	ExpiresAt     int64     `json:"expires_at"`
}

type signedCompleteClaims struct {
	UploadID  string    `json:"upload_id"`
	Token     string    `json:"token"`
	Bucket    string    `json:"bucket"`
	Key       string    `json:"key"`
	BlobID    string    `json:"blob_id"`
	PackID    uint32    `json:"pack_id"`
	Replicas  []Replica `json:"replicas"`
	ExpiresAt int64     `json:"expires_at"`
}

func (r *Registry) CreateUpload(ctx context.Context, req UploadCreateRequest) (UploadCreateResponse, error) {
	alloc, err := r.Allocate(ctx, req.Size)
	if err != nil {
		return UploadCreateResponse{}, err
	}
	id, err := randomHex(16)
	if err != nil {
		return UploadCreateResponse{}, err
	}
	token, err := randomHex(32)
	if err != nil {
		return UploadCreateResponse{}, err
	}
	expiresAt := time.Now().Add(15 * time.Minute).Unix()
	completeToken, err := signCompleteToken(r.cfg.UploadTokenSecret, signedCompleteClaims{
		UploadID:  id,
		Token:     token,
		Bucket:    req.Bucket,
		Key:       req.Key,
		BlobID:    alloc.BlobID,
		PackID:    alloc.PackID,
		Replicas:  alloc.Replicas,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		return UploadCreateResponse{}, err
	}
	if len(alloc.Replicas) == 0 {
		return UploadCreateResponse{}, fmt.Errorf("no replicas configured")
	}
	primary := alloc.Replicas[0]
	uploadToken, err := signUploadToken(r.cfg.UploadTokenSecret, signedUploadClaims{
		UploadID:      id,
		ServerID:      primary.ServerID,
		PackID:        alloc.PackID,
		EntryID:       alloc.EntryID,
		Guard:         alloc.Guard,
		Size:          req.Size,
		ContentType:   req.ContentType,
		Replicas:      alloc.Replicas,
		CompleteToken: completeToken,
		ExpiresAt:     expiresAt,
	})
	if err != nil {
		return UploadCreateResponse{}, err
	}
	targets := []UploadTarget{{
		ServerID:    primary.ServerID,
		UploadURL:   strings.TrimRight(uploadBaseURL(primary), "/") + "/uploads/" + url.PathEscape(id),
		UploadToken: uploadToken,
	}}
	return UploadCreateResponse{
		UploadID: id,
		BlobID:   alloc.BlobID,
		Targets:  targets,
	}, nil
}

func (r *Registry) CompleteUpload(id string, req UploadCompleteRequest) (*objectRecord, objectRecord, error) {
	claims, err := verifyCompleteToken(r.cfg.UploadTokenSecret, req.Token)
	if err != nil {
		return nil, objectRecord{}, err
	}
	if claims.UploadID != id {
		return nil, objectRecord{}, fmt.Errorf("invalid upload token")
	}
	meta, err := validateUploadMetadata(claims.Replicas, req.Metadata, r.writeQuorumFor(len(claims.Replicas)))
	if err != nil {
		return nil, objectRecord{}, err
	}

	var (
		previous   *objectRecord
		current    objectRecord
		prevSize   int64
		prevState  PackState
		packID     uint32
		packUpdate packState
	)
	r.mu.Lock()
	pack, ok := r.packs[claims.PackID]
	if !ok {
		r.mu.Unlock()
		return nil, objectRecord{}, fmt.Errorf("pack not found")
	}
	packID = claims.PackID
	prevSize = pack.SizeBytes
	prevState = pack.State
	pack.SizeBytes += int64(meta.Size)
	if pack.SizeBytes >= pack.MaxBytes {
		pack.State = PackStateReadonly
	}
	packUpdate = *pack
	r.mu.Unlock()

	err = r.db.Update(func(txn *badger.Txn) error {
		if err := setJSON(txn, packKey(packID), &packUpdate); err != nil {
			return err
		}
		if item, err := txn.Get(objectKey(claims.Bucket, claims.Key)); err == nil {
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			var old objectRecord
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
			previous = &old
		} else if err != badger.ErrKeyNotFound {
			return err
		}
		current = objectRecord{
			Bucket:    claims.Bucket,
			Key:       claims.Key,
			BlobID:    claims.BlobID,
			Metadata:  meta,
			UpdatedAt: time.Now().UTC(),
		}
		if err := setJSON(txn, objectKey(current.Bucket, current.Key), current); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		r.mu.Lock()
		if pack, ok := r.packs[packID]; ok {
			pack.SizeBytes = prevSize
			pack.State = prevState
		}
		r.mu.Unlock()
		return nil, objectRecord{}, err
	}
	r.objectCache.Put(current)
	return previous, current, nil
}

func (r *Registry) writeQuorumFor(replicaCount int) int {
	if replicaCount <= 0 {
		return 0
	}
	if r.cfg.WriteQuorum <= 0 {
		return replicaCount
	}
	if r.cfg.WriteQuorum > replicaCount {
		return replicaCount
	}
	return r.cfg.WriteQuorum
}

func validateUploadMetadata(replicas []Replica, metadataList []UploadMetadata, writeQuorum int) (ImageMetadata, error) {
	if len(replicas) == 0 {
		return ImageMetadata{}, fmt.Errorf("no replicas configured")
	}
	if writeQuorum <= 0 {
		writeQuorum = len(replicas)
	}
	replicaSet := make(map[string]struct{}, len(replicas))
	for _, replica := range replicas {
		replicaSet[replica.ServerID] = struct{}{}
	}
	metadataByServer := make(map[string]ImageMetadata, len(replicas))
	for _, item := range metadataList {
		if _, ok := replicaSet[item.ServerID]; !ok {
			continue
		}
		metadataByServer[item.ServerID] = item.Metadata
	}
	if len(metadataByServer) < writeQuorum {
		return ImageMetadata{}, fmt.Errorf("upload quorum not met: got %d, need %d", len(metadataByServer), writeQuorum)
	}
	var meta ImageMetadata
	first := true
	for _, replica := range replicas {
		current, ok := metadataByServer[replica.ServerID]
		if !ok {
			continue
		}
		if first {
			meta = current
			first = false
			continue
		}
		if current != meta {
			return ImageMetadata{}, fmt.Errorf("replica metadata mismatch")
		}
	}
	if meta.Size == 0 {
		return ImageMetadata{}, fmt.Errorf("empty body")
	}
	return meta, nil
}

func uploadBaseURL(replica Replica) string {
	if replica.PublicURL != "" {
		return replica.PublicURL
	}
	return replica.URL
}

func verifyUploadToken(secret string, token string) (signedUploadClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return signedUploadClaims{}, fmt.Errorf("invalid upload token")
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return signedUploadClaims{}, fmt.Errorf("invalid upload token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return signedUploadClaims{}, fmt.Errorf("invalid upload token")
	}
	expected := signUploadPayload(secret, payloadRaw)
	if !hmac.Equal(signature, expected) {
		return signedUploadClaims{}, fmt.Errorf("invalid upload token")
	}
	var claims signedUploadClaims
	if err := json.Unmarshal(payloadRaw, &claims); err != nil {
		return signedUploadClaims{}, fmt.Errorf("invalid upload token")
	}
	if claims.ExpiresAt > 0 && time.Now().Unix() > claims.ExpiresAt {
		return signedUploadClaims{}, fmt.Errorf("expired upload token")
	}
	return claims, nil
}

func signUploadToken(secret string, claims signedUploadClaims) (string, error) {
	payloadRaw, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signature := signUploadPayload(secret, payloadRaw)
	return base64.RawURLEncoding.EncodeToString(payloadRaw) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func signUploadPayload(secret string, payload []byte) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func verifyCompleteToken(secret string, token string) (signedCompleteClaims, error) {
	var claims signedCompleteClaims
	if err := verifySignedClaims(secret, token, &claims); err != nil {
		return signedCompleteClaims{}, err
	}
	return claims, nil
}

func signCompleteToken(secret string, claims signedCompleteClaims) (string, error) {
	return signClaims(secret, claims)
}

func signClaims(secret string, claims any) (string, error) {
	payloadRaw, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signature := signUploadPayload(secret, payloadRaw)
	return base64.RawURLEncoding.EncodeToString(payloadRaw) + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func verifySignedClaims(secret string, token string, claims any) error {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return fmt.Errorf("invalid upload token")
	}
	payloadRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return fmt.Errorf("invalid upload token")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("invalid upload token")
	}
	expected := signUploadPayload(secret, payloadRaw)
	if !hmac.Equal(signature, expected) {
		return fmt.Errorf("invalid upload token")
	}
	if err := json.Unmarshal(payloadRaw, claims); err != nil {
		return fmt.Errorf("invalid upload token")
	}
	switch typed := claims.(type) {
	case *signedUploadClaims:
		if typed.ExpiresAt > 0 && time.Now().Unix() > typed.ExpiresAt {
			return fmt.Errorf("expired upload token")
		}
	case *signedCompleteClaims:
		if typed.ExpiresAt > 0 && time.Now().Unix() > typed.ExpiresAt {
			return fmt.Errorf("expired upload token")
		}
	}
	return nil
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

package images

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dgraph-io/badger/v4"
)

const heartbeatTTL = 15 * time.Second

type serverState struct {
	ServerID      string                `json:"server_id"`
	URL           string                `json:"url"`
	PublicURL     string                `json:"public_url"`
	FreeBytes     int64                 `json:"free_bytes"`
	MaxPackBytes  int64                 `json:"max_pack_bytes"`
	LastHeartbeat time.Time             `json:"last_heartbeat"`
	Healthy       bool                  `json:"healthy"`
	Packs         map[uint32]serverPack `json:"packs"`
}

type serverPack struct {
	State PackState `json:"state"`
	Size  int64     `json:"size"`
}

type packState struct {
	PackID      uint32    `json:"pack_id"`
	State       PackState `json:"state"`
	Replicas    []Replica `json:"replicas"`
	NextEntryID uint64    `json:"next_entry_id"`
	MaxBytes    int64     `json:"max_bytes"`
	SizeBytes   int64     `json:"size_bytes"`
}

type Registry struct {
	mu          sync.RWMutex
	cfg         CoordinatorConfig
	client      *http.Client
	db          *badger.DB
	nextPack    uint32
	servers     map[string]*serverState
	packs       map[uint32]*packState
	objectCache *objectCache
}

func LoadRegistry(cfg CoordinatorConfig) (*Registry, error) {
	if err := os.MkdirAll(filepath.Clean(cfg.DBPath), 0o755); err != nil {
		return nil, err
	}
	opts := badger.DefaultOptions(cfg.DBPath)
	opts.Logger = nil
	db, err := badger.Open(opts)
	if err != nil {
		return nil, err
	}
	r := &Registry{
		cfg:         cfg,
		client:      &http.Client{Timeout: cfg.HTTPTimeout},
		db:          db,
		servers:     make(map[string]*serverState),
		packs:       make(map[uint32]*packState),
		objectCache: newObjectCache(cfg.ObjectCacheEntries),
	}
	if err := r.load(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if r.nextPack == 0 {
		r.nextPack = 1
	}
	return r, nil
}

func (r *Registry) Close() error {
	return r.db.Close()
}

func (r *Registry) load() error {
	return r.db.View(func(txn *badger.Txn) error {
		if item, err := txn.Get(metaNextPackKey()); err == nil {
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			if err := json.Unmarshal(raw, &r.nextPack); err != nil {
				return err
			}
		} else if err != badger.ErrKeyNotFound {
			return err
		}

		iter := txn.NewIterator(badger.DefaultIteratorOptions)
		defer iter.Close()

		for iter.Seek(serverPrefix()); iter.ValidForPrefix(serverPrefix()); iter.Next() {
			item := iter.Item()
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			var server serverState
			if err := json.Unmarshal(raw, &server); err != nil {
				return err
			}
			serverCopy := server
			r.servers[server.ServerID] = &serverCopy
		}

		for iter.Seek(packPrefix()); iter.ValidForPrefix(packPrefix()); iter.Next() {
			item := iter.Item()
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			var pack packState
			if err := json.Unmarshal(raw, &pack); err != nil {
				return err
			}
			packCopy := pack
			r.packs[pack.PackID] = &packCopy
		}
		return nil
	})
}

func (r *Registry) Heartbeat(req HeartbeatRequest) error {
	var stateCopy serverState
	packCopies := make(map[uint32]packState)
	r.mu.Lock()
	state, ok := r.servers[req.ServerID]
	if !ok {
		state = &serverState{ServerID: req.ServerID}
		r.servers[req.ServerID] = state
	}
	state.URL = req.URL
	state.PublicURL = req.PublicURL
	state.FreeBytes = req.FreeBytes
	state.MaxPackBytes = req.MaxPackBytes
	state.LastHeartbeat = time.Now().UTC()
	state.Healthy = true
	state.Packs = make(map[uint32]serverPack, len(req.Packs))
	touchedPacks := make([]uint32, 0, len(req.Packs))
	for _, pack := range req.Packs {
		state.Packs[pack.PackID] = serverPack{State: pack.State, Size: pack.Size}
		if existing, ok := r.packs[pack.PackID]; ok {
			existing.SizeBytes = pack.Size
			if existing.State != PackStateCompacting {
				existing.State = pack.State
			}
			touchedPacks = append(touchedPacks, pack.PackID)
			packCopies[pack.PackID] = *existing
		}
	}
	stateCopy = *state
	r.mu.Unlock()

	return r.db.Update(func(txn *badger.Txn) error {
		if err := setJSON(txn, serverKey(req.ServerID), &stateCopy); err != nil {
			return err
		}
		for _, packID := range touchedPacks {
			pack := packCopies[packID]
			if err := setJSON(txn, packKey(packID), &pack); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Registry) Allocate(ctx context.Context, size uint64) (AllocateResponse, error) {
	var (
		packID      uint32
		entryID     uint64
		guard       uint32
		replicas    []Replica
		prevEntryID uint64
	)
	r.mu.Lock()
	pack, err := r.findWritablePackLocked(size)
	if err != nil {
		r.mu.Unlock()
		return AllocateResponse{}, err
	}
	prevEntryID = pack.NextEntryID
	entryID = pack.NextEntryID
	pack.NextEntryID++
	guard, err = randomUint32()
	if err != nil {
		r.mu.Unlock()
		return AllocateResponse{}, err
	}
	packID = pack.PackID
	replicas = append(replicas, pack.Replicas...)
	packCopy := *pack
	r.mu.Unlock()

	blobID := BlobID{PackID: packID, EntryID: entryID, Guard: guard}
	if err := r.db.Update(func(txn *badger.Txn) error {
		return setJSON(txn, packKey(packID), &packCopy)
	}); err != nil {
		r.mu.Lock()
		if current, ok := r.packs[packID]; ok && current.NextEntryID == entryID+1 {
			current.NextEntryID = prevEntryID
		}
		r.mu.Unlock()
		return AllocateResponse{}, err
	}
	return AllocateResponse{
		BlobID:   blobID.String(),
		PackID:   packID,
		EntryID:  entryID,
		Guard:    guard,
		Replicas: replicas,
	}, nil
}

func (r *Registry) Lookup(packID uint32) (LookupResponse, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	pack, ok := r.packs[packID]
	if !ok {
		return LookupResponse{}, fmt.Errorf("pack not found")
	}
	return LookupResponse{
		PackID:   packID,
		State:    pack.State,
		Replicas: append([]Replica(nil), pack.Replicas...),
	}, nil
}

func (r *Registry) findWritablePackLocked(size uint64) (*packState, error) {
	now := time.Now().UTC()
	for _, pack := range r.packs {
		if pack.State == PackStateWritable &&
			(size == 0 || pack.SizeBytes+int64(size) <= pack.MaxBytes) &&
			len(pack.Replicas) == r.cfg.ReplicaCount &&
			r.packReplicasHealthyLocked(pack, now) {
			return pack, nil
		}
	}
	return r.createPackLocked()
}

func (r *Registry) createPackLocked() (*packState, error) {
	now := time.Now().UTC()
	healthy := make([]*serverState, 0, len(r.servers))
	for _, server := range r.servers {
		if r.serverHealthyLocked(server, now) {
			healthy = append(healthy, server)
		}
	}
	if len(healthy) < r.cfg.ReplicaCount {
		return nil, fmt.Errorf("need at least %d healthy storage nodes", r.cfg.ReplicaCount)
	}
	sort.Slice(healthy, func(i, j int) bool {
		if healthy[i].FreeBytes == healthy[j].FreeBytes {
			return healthy[i].ServerID < healthy[j].ServerID
		}
		return healthy[i].FreeBytes > healthy[j].FreeBytes
	})
	selected := healthy[:r.cfg.ReplicaCount]
	replicas := make([]Replica, 0, len(selected))
	for _, server := range selected {
		replicas = append(replicas, Replica{ServerID: server.ServerID, URL: server.URL, PublicURL: server.PublicURL})
	}
	packID := r.nextPack
	r.nextPack++
	pack := &packState{
		PackID:      packID,
		State:       PackStateWritable,
		Replicas:    replicas,
		NextEntryID: 1,
		MaxBytes:    r.cfg.PackSizeBytes,
	}
	r.packs[packID] = pack
	for _, server := range selected {
		if server.Packs == nil {
			server.Packs = map[uint32]serverPack{}
		}
		server.Packs[packID] = serverPack{State: PackStateWritable}
		server.FreeBytes -= r.cfg.PackSizeBytes
		if server.FreeBytes < 0 {
			server.FreeBytes = 0
		}
	}
	if err := r.db.Update(func(txn *badger.Txn) error {
		if err := setJSON(txn, metaNextPackKey(), r.nextPack); err != nil {
			return err
		}
		if err := setJSON(txn, packKey(packID), pack); err != nil {
			return err
		}
		for _, server := range selected {
			if err := setJSON(txn, serverKey(server.ServerID), server); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return pack, nil
}

func (r *Registry) Status() map[string]any {
	r.mu.RLock()
	packs := make([]*packState, 0, len(r.packs))
	for _, pack := range r.packs {
		copyPack := *pack
		packs = append(packs, &copyPack)
	}
	packCount := len(r.packs)
	serverCount := len(r.servers)
	nextPackID := r.nextPack
	r.mu.RUnlock()

	sort.Slice(packs, func(i, j int) bool { return packs[i].PackID < packs[j].PackID })
	return map[string]any{
		"next_pack_id": nextPackID,
		"server_count": serverCount,
		"pack_count":   packCount,
		"packs":        packs,
	}
}

func (r *Registry) RunLightGC(ctx context.Context) error {
	type packReplicas struct {
		packID   uint32
		replicas []Replica
	}
	r.mu.RLock()
	packs := make([]packReplicas, 0, len(r.packs))
	for _, pack := range r.packs {
		packs = append(packs, packReplicas{
			packID:   pack.PackID,
			replicas: append([]Replica(nil), pack.Replicas...),
		})
	}
	r.mu.RUnlock()

	liveByPack := make(map[uint32]map[uint64]uint32)
	if err := r.db.View(func(txn *badger.Txn) error {
		iter := txn.NewIterator(badger.DefaultIteratorOptions)
		defer iter.Close()
		prefix := []byte("object/")
		for iter.Seek(prefix); iter.ValidForPrefix(prefix); iter.Next() {
			item := iter.Item()
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			var rec objectRecord
			if err := json.Unmarshal(raw, &rec); err != nil {
				return err
			}
			blobID, err := ParseBlobID(rec.BlobID)
			if err != nil {
				continue
			}
			byEntry, ok := liveByPack[blobID.PackID]
			if !ok {
				byEntry = make(map[uint64]uint32)
				liveByPack[blobID.PackID] = byEntry
			}
			byEntry[blobID.EntryID] = blobID.Guard
		}
		return nil
	}); err != nil {
		return err
	}

	for _, pack := range packs {
		liveEntries := make([]LiveEntry, 0, len(liveByPack[pack.packID]))
		for entryID, guard := range liveByPack[pack.packID] {
			liveEntries = append(liveEntries, LiveEntry{EntryID: entryID, Guard: guard})
		}
		for _, replica := range pack.replicas {
			if replica.URL == "" {
				continue
			}
			if err := postJSON(
				r.client,
				ctx,
				fmt.Sprintf("%s/internal/packs/%d/compact-live", strings.TrimRight(replica.URL, "/"), pack.packID),
				LiveCompactRequest{Entries: liveEntries},
				nil,
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *Registry) packReplicasHealthyLocked(pack *packState, now time.Time) bool {
	for _, replica := range pack.Replicas {
		server, ok := r.servers[replica.ServerID]
		if !ok || !r.serverHealthyLocked(server, now) {
			return false
		}
	}
	return true
}

func (r *Registry) serverHealthyLocked(server *serverState, now time.Time) bool {
	if server == nil || !server.Healthy || server.LastHeartbeat.IsZero() {
		return false
	}
	return now.Sub(server.LastHeartbeat) <= heartbeatTTL
}

func randomUint32() (uint32, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(math.MaxUint32)))
	if err != nil {
		return 0, err
	}
	return uint32(n.Uint64() + 1), nil
}

func postJSON(client *http.Client, ctx context.Context, url string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("unexpected status %s", resp.Status)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func metaNextPackKey() []byte {
	return []byte("meta/next_pack_id")
}

func serverPrefix() []byte {
	return []byte("server/")
}

func serverKey(serverID string) []byte {
	return []byte("server/" + serverID)
}

func packPrefix() []byte {
	return []byte("pack/")
}

func packKey(packID uint32) []byte {
	return []byte(fmt.Sprintf("pack/%08x", packID))
}

func setJSON(txn *badger.Txn, key []byte, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return txn.Set(key, raw)
}

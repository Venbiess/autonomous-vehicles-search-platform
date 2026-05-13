package images

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cespare/xxhash/v2"
)

var streamChunkPool = sync.Pool{
	New: func() any {
		buf := make([]byte, 128*1024)
		return &buf
	},
}

const (
	recordMagic    = "NDL1"
	recordHeaderSz = 72
	flagTombstone  = uint32(1)
	indexMagic     = "IDX1"
	checksumSize   = 8
)

type storedMetadata struct {
	ContentType string `json:"content_type"`
	Checksum    string `json:"checksum"`
}

type entry struct {
	EntryID     uint64
	Guard       uint32
	Flags       uint32
	Offset      int64
	MetadataLen uint32
	Size        uint64
	Metadata    ImageMetadata
}

type packFile struct {
	id       uint32
	path     string
	idxPath  string
	maxBytes int64

	mu              sync.RWMutex
	writeMu         sync.Mutex
	file            *os.File
	size            int64
	state           PackState
	index           map[uint64]entry
	snapshotDirty   bool
	mutationVersion uint64
}

type Store struct {
	mu         sync.RWMutex
	cfg        VolumeConfig
	packs      map[uint32]*packFile
	httpClient *http.Client
	stopCh     chan struct{}
	wg         sync.WaitGroup
}

func OpenStore(cfg VolumeConfig) (*Store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	store := &Store{
		cfg:        cfg,
		packs:      make(map[uint32]*packFile),
		httpClient: &http.Client{Timeout: cfg.HTTPTimeout},
		stopCh:     make(chan struct{}),
	}
	if err := store.loadExisting(); err != nil {
		return nil, err
	}
	store.startSnapshotLoop()
	return store, nil
}

func (s *Store) Close() error {
	close(s.stopCh)
	s.wg.Wait()

	s.mu.Lock()
	defer s.mu.Unlock()
	var firstErr error
	for _, pack := range s.packs {
		if err := pack.snapshotNow(); err != nil && firstErr == nil {
			firstErr = err
		}
		if err := pack.file.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Store) loadExisting() error {
	matches, err := filepath.Glob(filepath.Join(s.cfg.DataDir, "*.dat"))
	if err != nil {
		return err
	}
	for _, match := range matches {
		var packID uint32
		if _, err := fmt.Sscanf(filepath.Base(match), "%08x.dat", &packID); err != nil {
			continue
		}
		if _, err := s.ensurePack(packID, s.cfg.MaxPackBytes); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ensurePack(packID uint32, maxBytes int64) (*packFile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.packs[packID]; ok {
		return existing, nil
	}
	path := filepath.Join(s.cfg.DataDir, fmt.Sprintf("%08x.dat", packID))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	pack := &packFile{
		id:       packID,
		path:     path,
		idxPath:  filepath.Join(s.cfg.DataDir, fmt.Sprintf("%08x.idx", packID)),
		maxBytes: maxBytes,
		file:     file,
		size:     info.Size(),
		state:    PackStateWritable,
		index:    make(map[uint64]entry),
	}
	if err := pack.recover(); err != nil {
		_ = file.Close()
		return nil, err
	}
	if pack.size >= pack.maxBytes {
		pack.state = PackStateReadonly
	}
	s.packs[packID] = pack
	return pack, nil
}

func (s *Store) getPack(packID uint32) (*packFile, error) {
	s.mu.RLock()
	pack, ok := s.packs[packID]
	s.mu.RUnlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return pack, nil
}

func (p *packFile) recover() error {
	info, err := p.file.Stat()
	if err != nil {
		return err
	}
	fileSize := info.Size()

	coveredOffset, err := p.loadSnapshot()
	if err != nil || coveredOffset > fileSize {
		p.index = make(map[uint64]entry)
		p.state = PackStateWritable
		coveredOffset = 0
	}
	offset, err := p.replayFrom(coveredOffset)
	if err != nil {
		if coveredOffset != 0 {
			p.index = make(map[uint64]entry)
			p.state = PackStateWritable
			offset, err = p.replayFrom(0)
		}
		if err != nil {
			return err
		}
	}
	p.size = offset
	if offset > coveredOffset || coveredOffset == 0 {
		p.snapshotDirty = true
		p.mutationVersion = 1
	}
	return nil
}

func (p *packFile) loadSnapshot() (int64, error) {
	raw, err := os.ReadFile(p.idxPath)
	if err != nil {
		return 0, err
	}
	reader := bytes.NewReader(raw)
	magic := make([]byte, len(indexMagic))
	if _, err := io.ReadFull(reader, magic); err != nil {
		return 0, err
	}
	if string(magic) != indexMagic {
		return 0, fmt.Errorf("invalid index snapshot")
	}
	var coveredOffset int64
	var size int64
	var stateByte uint8
	var count uint32
	if err := binary.Read(reader, binary.BigEndian, &coveredOffset); err != nil {
		return 0, err
	}
	if err := binary.Read(reader, binary.BigEndian, &size); err != nil {
		return 0, err
	}
	if err := binary.Read(reader, binary.BigEndian, &stateByte); err != nil {
		return 0, err
	}
	if err := binary.Read(reader, binary.BigEndian, &count); err != nil {
		return 0, err
	}
	p.index = make(map[uint64]entry, count)
	for range count {
		var item entry
		if err := binary.Read(reader, binary.BigEndian, &item.EntryID); err != nil {
			return 0, err
		}
		if err := binary.Read(reader, binary.BigEndian, &item.Guard); err != nil {
			return 0, err
		}
		if err := binary.Read(reader, binary.BigEndian, &item.Flags); err != nil {
			return 0, err
		}
		if err := binary.Read(reader, binary.BigEndian, &item.Offset); err != nil {
			return 0, err
		}
		if err := binary.Read(reader, binary.BigEndian, &item.MetadataLen); err != nil {
			return 0, err
		}
		if err := binary.Read(reader, binary.BigEndian, &item.Size); err != nil {
			return 0, err
		}
		p.index[item.EntryID] = item
	}
	p.size = size
	p.state = packStateFromByte(stateByte)
	return coveredOffset, nil
}

func (p *packFile) replayFrom(offset int64) (int64, error) {
	if _, err := p.file.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	reader := bufio.NewReader(p.file)
	currentOffset := offset
	for {
		item, nextOffset, err := readRecord(reader, currentOffset)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return currentOffset, nil
			}
			return 0, err
		}
		p.index[item.EntryID] = item
		currentOffset = nextOffset
	}
}

func readRecord(reader *bufio.Reader, offset int64) (entry, int64, error) {
	header := make([]byte, recordHeaderSz)
	if _, err := io.ReadFull(reader, header); err != nil {
		return entry{}, 0, err
	}
	if string(header[:4]) != recordMagic {
		return entry{}, 0, fmt.Errorf("invalid record magic at offset %d", offset)
	}
	entryID := binary.BigEndian.Uint64(header[4:12])
	guard := binary.BigEndian.Uint32(header[12:16])
	flags := binary.BigEndian.Uint32(header[16:20])
	metaLen := binary.BigEndian.Uint32(header[20:24])
	dataSize := binary.BigEndian.Uint64(header[24:32])
	checksumRaw := header[32 : 32+checksumSize]
	metaBytes := make([]byte, metaLen)
	if _, err := io.ReadFull(reader, metaBytes); err != nil {
		return entry{}, 0, err
	}
	payloadOffset := offset + recordHeaderSz + int64(metaLen)
	if _, err := io.CopyN(io.Discard, reader, int64(dataSize)); err != nil {
		return entry{}, 0, err
	}
	total := recordHeaderSz + int64(metaLen) + int64(dataSize)
	padding := paddedBytes(total) - total
	if padding > 0 {
		if _, err := io.CopyN(io.Discard, reader, padding); err != nil {
			return entry{}, 0, err
		}
	}
	item := entry{
		EntryID:     entryID,
		Guard:       guard,
		Flags:       flags,
		Offset:      payloadOffset,
		MetadataLen: metaLen,
		Size:        dataSize,
		Metadata: ImageMetadata{
			Size:     dataSize,
			Checksum: hex.EncodeToString(checksumRaw),
		},
	}
	if metaLen > 0 {
		var stored storedMetadata
		if err := json.Unmarshal(metaBytes, &stored); err == nil {
			if stored.ContentType != "" {
				item.Metadata.ContentType = stored.ContentType
			}
			if stored.Checksum != "" && stored.Checksum != strings.Repeat("0", checksumSize*2) {
				item.Metadata.Checksum = stored.Checksum
			}
		}
	}
	return item, offset + paddedBytes(total), nil
}

func (p *packFile) saveSnapshot(snapshot snapshotState) error {
	var buf bytes.Buffer
	buf.Grow(32 + len(snapshot.Index)*36)
	buf.WriteString(indexMagic)
	if err := binary.Write(&buf, binary.BigEndian, snapshot.CoveredOffset); err != nil {
		return err
	}
	if err := binary.Write(&buf, binary.BigEndian, snapshot.Size); err != nil {
		return err
	}
	if err := binary.Write(&buf, binary.BigEndian, packStateToByte(snapshot.State)); err != nil {
		return err
	}
	count := uint32(len(snapshot.Index))
	if err := binary.Write(&buf, binary.BigEndian, count); err != nil {
		return err
	}
	for _, item := range snapshot.Index {
		if err := binary.Write(&buf, binary.BigEndian, item.EntryID); err != nil {
			return err
		}
		if err := binary.Write(&buf, binary.BigEndian, item.Guard); err != nil {
			return err
		}
		if err := binary.Write(&buf, binary.BigEndian, item.Flags); err != nil {
			return err
		}
		if err := binary.Write(&buf, binary.BigEndian, item.Offset); err != nil {
			return err
		}
		if err := binary.Write(&buf, binary.BigEndian, item.MetadataLen); err != nil {
			return err
		}
		if err := binary.Write(&buf, binary.BigEndian, item.Size); err != nil {
			return err
		}
	}
	tmpPath := p.idxPath + ".tmp"
	if err := os.WriteFile(tmpPath, buf.Bytes(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, p.idxPath)
}

type snapshotState struct {
	CoveredOffset int64   `json:"covered_offset"`
	Size          int64   `json:"size"`
	State         string  `json:"state"`
	Index         []entry `json:"index"`
}

func (s *Store) Write(packID uint32, req EntryWriteRequest, body io.Reader) (ImageMetadata, error) {
	pack, err := s.ensurePack(packID, s.cfg.MaxPackBytes)
	if err != nil {
		return ImageMetadata{}, err
	}
	item, err := pack.appendStream(req, body)
	if err != nil {
		return ImageMetadata{}, err
	}
	return item.Metadata, nil
}

func (s *Store) Delete(packID uint32, req EntryDeleteRequest) error {
	pack, err := s.getPack(packID)
	if err != nil {
		return err
	}
	return pack.appendTombstone(req.EntryID, req.Guard)
}

func (s *Store) Read(packID uint32, entryID uint64, guard uint32) (entry, io.ReadSeekCloser, error) {
	pack, err := s.getPack(packID)
	if err != nil {
		return entry{}, nil, err
	}
	return pack.read(entryID, guard)
}

func (s *Store) Compact(packID uint32) error {
	pack, err := s.getPack(packID)
	if err != nil {
		return err
	}
	return pack.compact(nil)
}

func (s *Store) CompactLive(packID uint32, entries []LiveEntry) error {
	pack, err := s.getPack(packID)
	if err != nil {
		return err
	}
	live := make(map[uint64]uint32, len(entries))
	for _, item := range entries {
		live[item.EntryID] = item.Guard
	}
	return pack.compact(live)
}

func (s *Store) RepairVolume(packID uint32, replicas []Replica) error {
	pack, err := s.getPack(packID)
	if err != nil {
		return err
	}
	return pack.repairToReplicas(s, replicas)
}

func (s *Store) CompactAll() error {
	s.mu.RLock()
	packIDs := make([]uint32, 0, len(s.packs))
	for packID := range s.packs {
		packIDs = append(packIDs, packID)
	}
	s.mu.RUnlock()
	sort.Slice(packIDs, func(i, j int) bool { return packIDs[i] < packIDs[j] })
	for _, packID := range packIDs {
		if err := s.Compact(packID); err != nil {
			return fmt.Errorf("compact pack %d: %w", packID, err)
		}
	}
	return nil
}

func (s *Store) Heartbeat() HeartbeatRequest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	packs := make([]HeartbeatPack, 0, len(s.packs))
	for _, pack := range s.packs {
		pack.mu.RLock()
		packs = append(packs, HeartbeatPack{
			PackID: pack.id,
			State:  pack.state,
			Size:   pack.size,
		})
		pack.mu.RUnlock()
	}
	return HeartbeatRequest{
		ServerID:     s.cfg.ServerID,
		URL:          s.cfg.InternalURL,
		PublicURL:    s.cfg.PublicURL,
		FreeBytes:    diskFreeGuess(s.cfg.MaxPackBytes, packs),
		MaxPackBytes: s.cfg.MaxPackBytes,
		Packs:        packs,
	}
}

func (s *Store) writeToReplica(baseURL string, packID uint32, req EntryWriteRequest, body io.Reader) error {
	_, err := postBinary(s.httpClient, baseURL, fmt.Sprintf("/internal/packs/%d/write", packID), req, body, int64(req.Metadata.Size))
	return err
}

func (p *packFile) appendStream(req EntryWriteRequest, body io.Reader) (entry, error) {
	if req.Metadata.Size == 0 {
		return entry{}, fmt.Errorf("content-length is required")
	}
	if req.Metadata.Size > uint64(^uint(0)>>1) {
		return entry{}, fmt.Errorf("object too large")
	}

	p.writeMu.Lock()
	defer p.writeMu.Unlock()

	p.mu.RLock()
	if p.state == PackStateReadonly {
		p.mu.RUnlock()
		return entry{}, fmt.Errorf("pack is readonly")
	}
	offset := p.size
	p.mu.RUnlock()

	sniffSize := int(req.Metadata.Size)
	if sniffSize > 512 {
		sniffSize = 512
	}
	prefix := make([]byte, sniffSize)
	if _, err := io.ReadFull(body, prefix); err != nil {
		return entry{}, fmt.Errorf("read request body: %w", err)
	}

	metadata := BuildImageMetadata(req.Metadata.Size, "", prefix, req.Metadata.ContentType)
	metaBytes, err := marshalStoredMetadata(metadata)
	if err != nil {
		return entry{}, err
	}

	header := make([]byte, recordHeaderSz)
	copy(header[:4], []byte(recordMagic))
	binary.BigEndian.PutUint64(header[4:12], req.EntryID)
	binary.BigEndian.PutUint32(header[12:16], req.Guard)
	binary.BigEndian.PutUint32(header[16:20], 0)
	binary.BigEndian.PutUint32(header[20:24], uint32(len(metaBytes)))
	binary.BigEndian.PutUint64(header[24:32], req.Metadata.Size)
	binary.BigEndian.PutUint64(header[64:72], uint64(time.Now().Unix()))

	payloadOffset := offset + recordHeaderSz + int64(len(metaBytes))
	total := recordHeaderSz + int64(len(metaBytes)) + int64(req.Metadata.Size)
	padding := paddedBytes(total) - total

	if _, err := p.file.Seek(offset, io.SeekStart); err != nil {
		return entry{}, fmt.Errorf("seek pack file: %w", err)
	}
	if _, err := p.file.Write(header); err != nil {
		return entry{}, fmt.Errorf("write record header: %w", err)
	}
	if _, err := p.file.Write(metaBytes); err != nil {
		_ = p.file.Truncate(offset)
		return entry{}, fmt.Errorf("write record metadata: %w", err)
	}

	hasher := xxhash.New()
	if len(prefix) > 0 {
		if _, err := hasher.Write(prefix); err != nil {
			return entry{}, err
		}
		if _, err := p.file.Write(prefix); err != nil {
			_ = p.file.Truncate(offset)
			return entry{}, fmt.Errorf("write record body: %w", err)
		}
	}

	remaining := int64(req.Metadata.Size) - int64(len(prefix))
	bufPtr := streamChunkPool.Get().(*[]byte)
	buf := *bufPtr
	defer streamChunkPool.Put(bufPtr)
	for remaining > 0 {
		chunkSize := len(buf)
		if int64(chunkSize) > remaining {
			chunkSize = int(remaining)
		}
		n, err := io.ReadFull(body, buf[:chunkSize])
		if err != nil {
			_ = p.file.Truncate(offset)
			return entry{}, fmt.Errorf("read request body: %w", err)
		}
		chunk := buf[:n]
		if _, err := hasher.Write(chunk); err != nil {
			return entry{}, err
		}
		if _, err := p.file.Write(chunk); err != nil {
			_ = p.file.Truncate(offset)
			return entry{}, fmt.Errorf("write record body: %w", err)
		}
		remaining -= int64(n)
	}

	if padding > 0 {
		paddingBuf := make([]byte, padding)
		if _, err := p.file.Write(paddingBuf); err != nil {
			_ = p.file.Truncate(offset)
			return entry{}, fmt.Errorf("write record padding: %w", err)
		}
	}

	metadata.Checksum = fmt.Sprintf("%016x", hasher.Sum64())
	if checksumRaw, err := hex.DecodeString(metadata.Checksum); err == nil {
		copy(header[32:32+checksumSize], checksumRaw)
	} else {
		_ = p.file.Truncate(offset)
		return entry{}, err
	}
	if _, err := p.file.WriteAt(header[32:32+checksumSize], offset+32); err != nil {
		_ = p.file.Truncate(offset)
		return entry{}, fmt.Errorf("patch record checksum: %w", err)
	}
	if err := p.file.Sync(); err != nil {
		_ = p.file.Truncate(offset)
		return entry{}, fmt.Errorf("sync pack file: %w", err)
	}

	item := entry{
		EntryID:     req.EntryID,
		Guard:       req.Guard,
		Flags:       0,
		Offset:      payloadOffset,
		MetadataLen: uint32(len(metaBytes)),
		Size:        metadata.Size,
		Metadata:    metadata,
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	p.size += total + padding
	p.index[req.EntryID] = item
	if p.size >= p.maxBytes {
		p.state = PackStateReadonly
	}
	p.snapshotDirty = true
	p.mutationVersion++
	return item, nil
}

func (p *packFile) appendTombstoneEntry(entryID uint64, guard uint32) (entry, error) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	p.mu.Lock()
	defer p.mu.Unlock()

	header := make([]byte, recordHeaderSz)
	copy(header[:4], []byte(recordMagic))
	binary.BigEndian.PutUint64(header[4:12], entryID)
	binary.BigEndian.PutUint32(header[12:16], guard)
	binary.BigEndian.PutUint32(header[16:20], flagTombstone)
	binary.BigEndian.PutUint64(header[64:72], uint64(time.Now().Unix()))

	metadata := ImageMetadata{
		Checksum: strings.Repeat("0", checksumSize*2),
		Size:     0,
	}
	checksumBytes, err := hex.DecodeString(metadata.Checksum)
	if err != nil {
		return entry{}, err
	}
	copy(header[32:64], checksumBytes)

	offset := p.size
	payloadOffset := offset + recordHeaderSz
	if _, err := p.file.Seek(offset, io.SeekStart); err != nil {
		return entry{}, fmt.Errorf("seek pack file: %w", err)
	}
	if _, err := p.file.Write(header); err != nil {
		return entry{}, fmt.Errorf("write tombstone header: %w", err)
	}
	if err := p.file.Sync(); err != nil {
		_ = p.file.Truncate(offset)
		_, _ = p.file.Seek(offset, io.SeekStart)
		return entry{}, fmt.Errorf("sync pack file: %w", err)
	}

	item := entry{
		EntryID:     entryID,
		Guard:       guard,
		Flags:       flagTombstone,
		Offset:      payloadOffset,
		MetadataLen: 0,
		Size:        0,
		Metadata:    metadata,
	}
	p.size += recordHeaderSz
	p.index[entryID] = item
	if p.size >= p.maxBytes {
		p.state = PackStateReadonly
	}
	p.snapshotDirty = true
	p.mutationVersion++
	return item, nil
}

func (p *packFile) appendTombstone(entryID uint64, guard uint32) error {
	_, err := p.appendTombstoneEntry(entryID, guard)
	return err
}

func (p *packFile) read(entryID uint64, guard uint32) (entry, io.ReadSeekCloser, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	item, ok := p.index[entryID]
	if !ok || item.Guard != guard || item.Flags&flagTombstone != 0 {
		return entry{}, nil, os.ErrNotExist
	}
	return item, &readSeekCloser{
		Reader: io.NewSectionReader(p.file, item.Offset, int64(item.Size)),
	}, nil
}

func (p *packFile) compact(live map[uint64]uint32) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state = PackStateCompacting
	tmpPath := p.path + ".compact"
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer tmpFile.Close()

	newIndex := make(map[uint64]entry)
	var offset int64
	keys := make([]uint64, 0, len(p.index))
	for entryID, item := range p.index {
		if item.Flags&flagTombstone != 0 {
			continue
		}
		if live != nil {
			guard, ok := live[entryID]
			if !ok || guard != item.Guard {
				continue
			}
		}
		keys = append(keys, entryID)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	src, err := os.Open(p.path)
	if err != nil {
		return err
	}
	defer src.Close()
	for _, entryID := range keys {
		item := p.index[entryID]
		recordStart := item.Offset - recordHeaderSz - int64(item.MetadataLen)
		recordLength := paddedBytes(recordHeaderSz + int64(item.MetadataLen) + int64(item.Size))
		if _, err := src.Seek(recordStart, io.SeekStart); err != nil {
			return err
		}
		buf := make([]byte, recordLength)
		if _, err := io.ReadFull(src, buf); err != nil {
			return err
		}
		if _, err := tmpFile.Write(buf); err != nil {
			return err
		}
		item.Offset = offset + recordHeaderSz + int64(item.MetadataLen)
		newIndex[entryID] = item
		offset += recordLength
	}
	if err := tmpFile.Sync(); err != nil {
		return err
	}
	if err := p.file.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, p.path); err != nil {
		return err
	}
	file, err := os.OpenFile(p.path, os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	p.file = file
	p.index = newIndex
	p.size = offset
	if p.size < p.maxBytes {
		p.state = PackStateWritable
	} else {
		p.state = PackStateReadonly
	}
	p.snapshotDirty = true
	p.mutationVersion++
	return p.snapshotNow()
}

func (p *packFile) repairToReplicas(store *Store, replicas []Replica) error {
	p.mu.RLock()
	live := make([]entry, 0, len(p.index))
	for _, item := range p.index {
		if item.Flags&flagTombstone == 0 {
			live = append(live, item)
		}
	}
	sort.Slice(live, func(i, j int) bool { return live[i].EntryID < live[j].EntryID })
	p.mu.RUnlock()

	src, err := os.Open(p.path)
	if err != nil {
		return err
	}
	defer src.Close()
	for _, item := range live {
		body := make([]byte, item.Size)
		if _, err := src.Seek(item.Offset, io.SeekStart); err != nil {
			return err
		}
		if _, err := io.ReadFull(src, body); err != nil {
			return err
		}
		req := EntryWriteRequest{
			EntryID:  item.EntryID,
			Guard:    item.Guard,
			Metadata: item.Metadata,
		}
		for _, replica := range replicas {
			if replica.ServerID == store.cfg.ServerID {
				continue
			}
			if err := store.writeToReplica(replica.URL, p.id, req, bytes.NewReader(body)); err != nil {
				return err
			}
		}
	}
	return nil
}

func paddedBytes(n int64) int64 {
	rem := n % 8
	if rem == 0 {
		return n
	}
	return n + (8 - rem)
}

type readSeekCloser struct {
	Reader io.ReadSeeker
}

func (r *readSeekCloser) Read(p []byte) (int, error) {
	return r.Reader.Read(p)
}

func (r *readSeekCloser) Seek(offset int64, whence int) (int64, error) {
	return r.Reader.Seek(offset, whence)
}

func (r *readSeekCloser) Close() error {
	return nil
}

func diskFreeGuess(maxPackBytes int64, packs []HeartbeatPack) int64 {
	var used int64
	for _, pack := range packs {
		used += pack.Size
	}
	guess := maxPackBytes*1024 - used
	if guess < 0 {
		return 0
	}
	return guess
}

func marshalStoredMetadata(metadata ImageMetadata) ([]byte, error) {
	return json.Marshal(storedMetadata{
		ContentType: metadata.ContentType,
		Checksum:    metadata.Checksum,
	})
}

func packStateToByte(state string) uint8 {
	switch PackState(state) {
	case PackStateReadonly:
		return 1
	case PackStateCompacting:
		return 2
	case PackStateDead:
		return 3
	default:
		return 0
	}
}

func packStateFromByte(v uint8) PackState {
	switch v {
	case 1:
		return PackStateReadonly
	case 2:
		return PackStateCompacting
	case 3:
		return PackStateDead
	default:
		return PackStateWritable
	}
}

func (s *Store) startSnapshotLoop() {
	if s.cfg.SnapshotInterval <= 0 {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(s.cfg.SnapshotInterval)
		defer ticker.Stop()
		for {
			select {
			case <-s.stopCh:
				return
			case <-ticker.C:
				s.snapshotDirtyPacks()
			}
		}
	}()
}

func (s *Store) snapshotDirtyPacks() {
	s.mu.RLock()
	packs := make([]*packFile, 0, len(s.packs))
	for _, pack := range s.packs {
		packs = append(packs, pack)
	}
	s.mu.RUnlock()

	for _, pack := range packs {
		_ = pack.snapshotNow()
	}
}

func (p *packFile) snapshotNow() error {
	snapshot, version, dirty := p.buildSnapshot()
	if !dirty {
		return nil
	}
	if err := p.saveSnapshot(snapshot); err != nil {
		return err
	}
	p.mu.Lock()
	if p.mutationVersion == version {
		p.snapshotDirty = false
	}
	p.mu.Unlock()
	return nil
}

func (p *packFile) buildSnapshot() (snapshotState, uint64, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if !p.snapshotDirty {
		return snapshotState{}, 0, false
	}
	items := make([]entry, 0, len(p.index))
	for _, item := range p.index {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].EntryID < items[j].EntryID })
	return snapshotState{
		CoveredOffset: p.size,
		Size:          p.size,
		State:         string(p.state),
		Index:         items,
	}, p.mutationVersion, true
}

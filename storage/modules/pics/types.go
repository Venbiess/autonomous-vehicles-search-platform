package images

type Replica struct {
	ServerID  string `json:"server_id"`
	URL       string `json:"url"`
	PublicURL string `json:"public_url,omitempty"`
}

type PackState string

const (
	PackStateWritable   PackState = "writable"
	PackStateReadonly   PackState = "readonly"
	PackStateCompacting PackState = "compacting"
	PackStateDead       PackState = "dead"
)

type AllocateResponse struct {
	BlobID   string    `json:"blob_id"`
	PackID   uint32    `json:"pack_id"`
	EntryID  uint64    `json:"entry_id"`
	Guard    uint32    `json:"guard"`
	Replicas []Replica `json:"replicas"`
}

type LookupResponse struct {
	PackID   uint32    `json:"pack_id"`
	State    PackState `json:"state"`
	Replicas []Replica `json:"replicas"`
}

type HeartbeatPack struct {
	PackID uint32    `json:"pack_id"`
	State  PackState `json:"state"`
	Size   int64     `json:"size"`
}

type HeartbeatRequest struct {
	ServerID     string          `json:"server_id"`
	URL          string          `json:"url"`
	PublicURL    string          `json:"public_url"`
	FreeBytes    int64           `json:"free_bytes"`
	MaxPackBytes int64           `json:"max_pack_bytes"`
	Packs        []HeartbeatPack `json:"packs"`
}

type EntryWriteRequest struct {
	EntryID  uint64        `json:"entry_id"`
	Guard    uint32        `json:"guard"`
	Metadata ImageMetadata `json:"metadata"`
}

type EntryWriteResponse struct {
	Metadata ImageMetadata `json:"metadata"`
}

type EntryDeleteRequest struct {
	EntryID uint64 `json:"entry_id"`
	Guard   uint32 `json:"guard"`
}

type UploadCreateRequest struct {
	Bucket      string `json:"bucket"`
	Key         string `json:"key"`
	ContentType string `json:"content_type"`
	Size        uint64 `json:"size"`
}

type UploadTarget struct {
	ServerID    string `json:"server_id"`
	UploadURL   string `json:"upload_url"`
	UploadToken string `json:"upload_token"`
}

type UploadCreateResponse struct {
	UploadID string         `json:"upload_id"`
	BlobID   string         `json:"blob_id"`
	Targets  []UploadTarget `json:"targets"`
}

type UploadCompleteRequest struct {
	Token    string           `json:"token"`
	Metadata []UploadMetadata `json:"metadata"`
}

type UploadMetadata struct {
	ServerID string        `json:"server_id"`
	Metadata ImageMetadata `json:"metadata"`
}

type LiveEntry struct {
	EntryID uint64 `json:"entry_id"`
	Guard   uint32 `json:"guard"`
}

type LiveCompactRequest struct {
	Entries []LiveEntry `json:"entries"`
}

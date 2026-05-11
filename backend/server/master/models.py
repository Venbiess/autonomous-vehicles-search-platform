from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


VLM_RESPONSE_TYPES = {"short_text", "text", "yes_no", "number", "category"}
VLM_RESPONSE_HINTS = {
    "short_text": (
        "Answer briefly in a single short phrase. "
        "No explanations, no punctuation-heavy formatting."
    ),
    "text": "Answer with a detailed description in 3-5 sentences.",
    "yes_no": (
        "Answer with exactly one token: Yes or No. "
        "Do not add any extra words."
    ),
    "number": (
        "Answer with exactly one integer number only, for example: 0, 1, 2. "
        "Do not add units or text."
    ),
    "category": (
        "Answer with exactly one category label from the allowed list. "
        "Do not add explanations or extra words."
    ),
}


class JobStatus(str, Enum):
    RUNNING = "running"
    SUCCESS = "success"
    ERROR = "error"
    CANCELLED = "cancelled"


class BackfillRequest(BaseModel):
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(50, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False
    dataset: Optional[str] = None


class TextSearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(5, ge=1)
    max_rows: int = Field(10000, ge=1)


class VLMFieldDefinition(BaseModel):
    name: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    response_type: str = Field("text", min_length=1)


class VLMFieldsRequest(BaseModel):
    fields: List[VLMFieldDefinition] = Field(..., min_length=1)
    replace_missing: bool = False
    purge_deleted_values: bool = False


class VLMBackfillRequest(BaseModel):
    field_names: List[str] = Field(default_factory=list)
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(10, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False
    overwrite_existing: bool = False
    max_new_tokens: int = Field(32, ge=1, le=512)
    dataset: Optional[str] = None


class VLMFilterDefinition(BaseModel):
    field_name: str = Field(..., min_length=1)
    value: str = Field(..., min_length=1)
    match_mode: str = Field("exact", min_length=1)


class VLMSearchRequest(BaseModel):
    filters: List[VLMFilterDefinition] = Field(default_factory=list)
    limit: int = Field(100, ge=1, le=1000)


class CancelJobRequest(BaseModel):
    job_id: str = Field(..., min_length=1)
    install_cleanup_mode: str = Field("keep", min_length=1)


class RetryJobRequest(BaseModel):
    job_id: str = Field(..., min_length=1)


class ObjectIDsRequest(BaseModel):
    object_ids: List[str] = Field(default_factory=list)


class AnnotationRowRequest(BaseModel):
    object_id: str = Field(..., min_length=1)
    values: Dict[str, str] = Field(default_factory=dict)


class AnnotationRowsRequest(BaseModel):
    rows: List[AnnotationRowRequest] = Field(default_factory=list)


class DatasetInstallRequest(BaseModel):
    datasets: List[str] = Field(..., min_length=1)
    configs: Dict[str, Dict[str, Any]] = Field(default_factory=dict)


class WaymoAuthCompleteRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    code: str = Field(..., min_length=1)


@dataclass(frozen=True)
class EmbedResult:
    object_id: str
    embedding: List[float]
    dim: int


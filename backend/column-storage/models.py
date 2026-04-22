from __future__ import annotations

from typing import Dict, List

from pydantic import BaseModel, Field


class AnalyticsField(BaseModel):
    field_name: str
    prompt: str
    response_type: str


class FieldsResponse(BaseModel):
    fields: List[AnalyticsField]


class UpsertFieldsRequest(BaseModel):
    fields: List[AnalyticsField] = Field(default_factory=list)
    replace_missing: bool = False
    purge_deleted_values: bool = False


class AnnotationRow(BaseModel):
    object_id: str
    values: Dict[str, str] = Field(default_factory=dict)


class UpsertAnnotationsRequest(BaseModel):
    rows: List[AnnotationRow] = Field(default_factory=list)


class DeleteAnnotationsRequest(BaseModel):
    object_ids: List[str] = Field(default_factory=list)


class CompletedRequest(BaseModel):
    object_ids: List[str] = Field(default_factory=list)
    field_names: List[str] = Field(default_factory=list)


class CompletedResponse(BaseModel):
    object_ids: List[str]


class SearchFilter(BaseModel):
    field_name: str
    value: str
    match_mode: str = "exact"


class SearchRequest(BaseModel):
    filters: List[SearchFilter] = Field(default_factory=list)
    limit: int = 100


class SearchResult(BaseModel):
    object_id: str
    attributes: Dict[str, str]


class SearchResponse(BaseModel):
    results: List[SearchResult]

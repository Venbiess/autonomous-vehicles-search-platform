package server

import (
	"context"

	infra "avsp/storage/infra"
)

type AnalyticsServer struct {
	adapter infra.AnalyticsAdapter
}

func NewAnalyticsServer(adapter infra.AnalyticsAdapter) *AnalyticsServer {
	return &AnalyticsServer{adapter: adapter}
}

func (s *AnalyticsServer) Health(ctx context.Context) error { return s.adapter.Health(ctx) }
func (s *AnalyticsServer) GetFields(ctx context.Context, fieldNames []string) ([]AnalyticsField, error) {
	fields, err := s.adapter.GetFields(ctx, fieldNames)
	if err != nil {
		return nil, err
	}
	out := make([]AnalyticsField, 0, len(fields))
	for _, f := range fields {
		out = append(out, AnalyticsField{
			FieldName:    f.FieldName,
			Prompt:       f.Prompt,
			ResponseType: f.ResponseType,
		})
	}
	return out, nil
}
func (s *AnalyticsServer) UpsertFields(ctx context.Context, fields []AnalyticsField) error {
	adapterFields := make([]infra.AnalyticsField, 0, len(fields))
	for _, f := range fields {
		adapterFields = append(adapterFields, infra.AnalyticsField{
			FieldName:    f.FieldName,
			Prompt:       f.Prompt,
			ResponseType: f.ResponseType,
		})
	}
	return s.adapter.UpsertFields(ctx, adapterFields)
}
func (s *AnalyticsServer) UpsertAnnotations(ctx context.Context, rows []AnalyticsAnnotationRow) error {
	adapterRows := make([]infra.AnalyticsAnnotationRow, 0, len(rows))
	for _, row := range rows {
		adapterRows = append(adapterRows, infra.AnalyticsAnnotationRow{
			ObjectID: row.ObjectID,
			Values:   row.Values,
		})
	}
	return s.adapter.UpsertAnnotations(ctx, adapterRows)
}
func (s *AnalyticsServer) DeleteAnnotations(ctx context.Context, objectIDs []string) (int, error) {
	unique := dedupeNonEmpty(objectIDs)
	if len(unique) == 0 {
		return 0, nil
	}
	if err := s.adapter.DeleteAnnotations(ctx, unique); err != nil {
		return 0, err
	}
	return len(unique), nil
}
func (s *AnalyticsServer) ClearAnnotations(ctx context.Context) (int64, error) {
	return s.adapter.ClearAnnotations(ctx)
}
func (s *AnalyticsServer) CompletedObjectIDs(ctx context.Context, objectIDs []string, fieldNames []string) ([]string, error) {
	return s.adapter.CompletedObjectIDs(ctx, objectIDs, fieldNames)
}
func (s *AnalyticsServer) Search(ctx context.Context, filters []AnalyticsFilter, limit int) ([]AnalyticsSearchResult, error) {
	adapterFilters := make([]infra.AnalyticsFilter, 0, len(filters))
	for _, filter := range filters {
		adapterFilters = append(adapterFilters, infra.AnalyticsFilter{
			FieldName: filter.FieldName,
			Value:     filter.Value,
			MatchMode: filter.MatchMode,
		})
	}
	results, err := s.adapter.Search(ctx, adapterFilters, limit)
	if err != nil {
		return nil, err
	}
	out := make([]AnalyticsSearchResult, 0, len(results))
	for _, item := range results {
		out = append(out, AnalyticsSearchResult{
			ObjectID:   item.ObjectID,
			Attributes: item.Attributes,
		})
	}
	return out, nil
}

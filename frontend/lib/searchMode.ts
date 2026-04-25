export type SearchMode = "VLM" | "Browser" | "ANNOTATION" | "STORAGE" | "Job Monitor";

export const SEARCH_MODES: SearchMode[] = [
  "VLM",
  "Browser",
  "ANNOTATION",
  "STORAGE",
  "Job Monitor",
];

export const SEARCH_MODE_STORAGE_KEY = "avsp.searchMode";

export function isSearchMode(value: string | null | undefined): value is SearchMode {
  if (!value) {
    return false;
  }
  return SEARCH_MODES.includes(value as SearchMode);
}

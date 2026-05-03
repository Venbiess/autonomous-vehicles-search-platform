import fs from "fs";
import path from "path";

function resolveVisibilityFile() {
  const candidates = [
    path.join("/app", "storage", "config", "dataset_visibility.json"),
    path.join(process.cwd(), "storage", "config", "dataset_visibility.json"),
    path.join(process.cwd(), "..", "storage", "config", "dataset_visibility.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return candidates[2];
}

const VISIBILITY_FILE = resolveVisibilityFile();

function ensureParentDir() {
  const dir = path.dirname(VISIBILITY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeDatasetName(value) {
  return String(value || "").trim();
}

function normalizeHiddenList(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((item) => normalizeDatasetName(item))
        .filter((name) => name.length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));
}

export function loadDatasetVisibility() {
  try {
    if (!fs.existsSync(VISIBILITY_FILE)) {
      return { hidden_datasets: [] };
    }
    const raw = fs.readFileSync(VISIBILITY_FILE, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    return {
      hidden_datasets: normalizeHiddenList(parsed?.hidden_datasets),
    };
  } catch {
    return { hidden_datasets: [] };
  }
}

export function saveDatasetVisibility(hiddenDatasets) {
  ensureParentDir();
  const normalized = normalizeHiddenList(hiddenDatasets);
  const payload = {
    hidden_datasets: normalized,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(VISIBILITY_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payload;
}

export function isDatasetVisible(dataset) {
  const name = normalizeDatasetName(dataset);
  if (!name) return true;
  const hidden = new Set(loadDatasetVisibility().hidden_datasets);
  return !hidden.has(name);
}

export function filterVisibleObjects(objects) {
  const hidden = new Set(loadDatasetVisibility().hidden_datasets);
  return (Array.isArray(objects) ? objects : []).filter(
    (item) => !hidden.has(normalizeDatasetName(item?.bucket))
  );
}

export function visibilityMapForBuckets(buckets) {
  const hidden = new Set(loadDatasetVisibility().hidden_datasets);
  const out = {};
  for (const bucket of buckets || []) {
    const name = normalizeDatasetName(bucket);
    if (!name) continue;
    out[name] = !hidden.has(name);
  }
  return out;
}

export function setDatasetVisibility(dataset, visible) {
  const name = normalizeDatasetName(dataset);
  if (!name) {
    throw new Error("dataset is required");
  }
  const current = loadDatasetVisibility();
  const nextHidden = new Set(current.hidden_datasets);
  if (visible) {
    nextHidden.delete(name);
  } else {
    nextHidden.add(name);
  }
  return saveDatasetVisibility(Array.from(nextHidden));
}

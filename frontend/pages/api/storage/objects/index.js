import { readStorageJson } from "../../../../lib/storageServer";

function encodeCursorToken(payload) {
  const raw = JSON.stringify(payload || {});
  return Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursorToken(token) {
  const normalized = String(token || "").trim();
  if (!normalized) return { cursor: "", offset: 0 };
  try {
    const b64 = normalized
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    const cursor = typeof parsed?.cursor === "string" ? parsed.cursor : "";
    const offset = Number.isInteger(parsed?.offset) ? Math.max(0, parsed.offset) : 0;
    return { cursor, offset };
  } catch {
    return { cursor: "", offset: 0 };
  }
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesObject(item, query, dataset) {
  const bucket = String(item?.bucket || "").trim();
  if (dataset && bucket.toLowerCase() !== dataset) {
    return false;
  }
  if (!query) {
    return true;
  }
  const haystack = [
    item?.object_id,
    item?.storage_path,
    item?.bucket,
    item?.key,
    item?.content_type,
  ]
    .map((value) => String(value || ""))
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const limit = Math.max(1, Math.min(256, Number(req.query?.limit || 20)));
  const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor.trim() : "";
  const query = normalizeText(req.query?.q);
  const dataset = normalizeText(req.query?.dataset);
  const hasFilter = Boolean(query || dataset);

  if (!hasFilter) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (rawCursor) {
      params.set("cursor", rawCursor);
    }

    try {
      const payload = await readStorageJson(`/objects?${params.toString()}`);
      return res.status(200).json({
        items: payload.items || [],
        next_cursor: payload.next_cursor || "",
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json(error.payload || { error: error.message });
    }
  }

  const { cursor: initialCursor, offset: initialOffset } = decodeCursorToken(rawCursor);
  const scanLimitPages = Math.max(1, Math.min(100, Number(req.query?.scan_pages || 24)));
  const pageLimit = 256;
  const out = [];
  let cursor = initialCursor;
  let offset = initialOffset;
  let scannedPages = 0;
  let hasMore = false;

  try {
    while (scannedPages < scanLimitPages) {
      scannedPages += 1;
      const params = new URLSearchParams({ limit: String(pageLimit) });
      if (cursor) {
        params.set("cursor", cursor);
      }
      const payload = await readStorageJson(`/objects?${params.toString()}`);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const nextCursor = String(payload?.next_cursor || "").trim();
      let index = offset;
      if (!Number.isFinite(index) || index < 0 || index >= items.length) {
        index = 0;
      }
      for (; index < items.length; index += 1) {
        const item = items[index];
        if (!matchesObject(item, query, dataset)) {
          continue;
        }
        out.push(item);
        if (out.length >= limit) {
          let resumeCursor = cursor;
          let resumeOffset = index + 1;
          if (resumeOffset >= items.length) {
            resumeCursor = nextCursor;
            resumeOffset = 0;
          }
          const nextToken = resumeCursor || resumeOffset > 0
            ? encodeCursorToken({ cursor: resumeCursor, offset: resumeOffset })
            : "";
          return res.status(200).json({
            items: out,
            next_cursor: nextToken,
          });
        }
      }
      if (!nextCursor) {
        hasMore = false;
        break;
      }
      cursor = nextCursor;
      offset = 0;
      hasMore = true;
    }
    const nextToken = hasMore && cursor
      ? encodeCursorToken({ cursor, offset: 0 })
      : "";
    return res.status(200).json({
      items: out,
      next_cursor: nextToken,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message });
  }
}

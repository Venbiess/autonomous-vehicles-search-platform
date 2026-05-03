const storageEndpoint = (process.env.STORAGE_SERVER_ENDPOINT || "http://localhost:9013").replace(
  /\/$/,
  ""
);

function storageWriteToken() {
  return (process.env.STORAGE_WRITE_TOKEN || "").trim();
}

export async function POST(request) {
  try {
    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "file is required" }, { status: 400 });
    }

    const out = new FormData();
    out.append("file", file, file.name || "upload.jpg");

    const bucket = String(incoming.get("bucket") || "").trim();
    const key = String(incoming.get("key") || "").trim();
    const contentType = String(incoming.get("content_type") || "").trim();

    if (bucket) out.append("bucket", bucket);
    if (key) out.append("key", key);
    if (contentType) out.append("content_type", contentType);

    const headers = {};
    const token = storageWriteToken();
    if (token) {
      headers["X-Storage-Write-Token"] = token;
    }

    const response = await fetch(`${storageEndpoint}/objects/upload`, {
      method: "POST",
      headers,
      body: out,
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text };
      }
    }
    if (!response.ok) {
      const message =
        payload?.detail || payload?.error || `Upload failed with status ${response.status}`;
      return Response.json({ error: String(message) }, { status: response.status });
    }
    return Response.json(payload, { status: 200 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to upload local image" },
      { status: 500 }
    );
  }
}

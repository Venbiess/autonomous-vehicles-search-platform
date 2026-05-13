import fs from "fs/promises";
import path from "path";

const MAX_TAIL_LINES = 4000;
const DEFAULT_TAIL_LINES = 500;
const ALLOWED_SERVICES = new Set(["embedder", "vlm"]);
const FALLBACK_MODEL_LOG_DIR = "/tmp/avsp-model-logs";

function resolveTailLines(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TAIL_LINES;
  }
  return Math.min(Math.floor(parsed), MAX_TAIL_LINES);
}

function resolveLogDir() {
  const configured = String(process.env.MODEL_STARTUP_LOG_DIR || "").trim();
  if (configured) {
    return configured;
  }
  return path.join(process.cwd(), ".runtime_logs");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const service = String(req.query.service || "").trim().toLowerCase();
  if (!ALLOWED_SERVICES.has(service)) {
    return res
      .status(400)
      .json({ error: "service must be one of: embedder, vlm" });
  }

  const metaOnlyRaw = String(req.query.meta_only || "").trim().toLowerCase();
  const metaOnly = new Set(["1", "true", "yes", "on"]).has(metaOnlyRaw);
  const tail = resolveTailLines(req.query.tail);
  const primaryLogPath = path.join(resolveLogDir(), `${service}.log`);
  const fallbackLogPath = path.join(FALLBACK_MODEL_LOG_DIR, `${service}.log`);
  const candidatePaths =
    primaryLogPath === fallbackLogPath ? [primaryLogPath] : [primaryLogPath, fallbackLogPath];

  try {
    let logPath = "";
    let stat = null;
    let lastFsError = null;
    for (const candidate of candidatePaths) {
      try {
        stat = await fs.stat(candidate);
        logPath = candidate;
        break;
      } catch (error) {
        lastFsError = error;
        continue;
      }
    }
    if (!stat || !logPath) {
      return res.status(200).json({
        service,
        exists: false,
        path: primaryLogPath,
        size_bytes: 0,
        updated_at: null,
        content: "No startup logs yet.",
        warning:
          lastFsError && lastFsError.code && lastFsError.code !== "ENOENT"
            ? String(lastFsError.message || lastFsError.code)
            : undefined,
      });
    }

    if (metaOnly) {
      return res.status(200).json({
        service,
        exists: true,
        path: logPath,
        size_bytes: stat.size,
        updated_at: new Date(stat.mtimeMs).toISOString(),
      });
    }

    let raw = "";
    try {
      raw = await fs.readFile(logPath, "utf-8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return res.status(200).json({
          service,
          exists: false,
          path: logPath,
          size_bytes: 0,
          updated_at: null,
          content: "No startup logs yet.",
        });
      }
      throw error;
    }
    const normalized = raw.replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const content = lines.slice(-tail).join("\n").trim();
    return res.status(200).json({
      service,
      exists: true,
      path: logPath,
      size_bytes: stat.size,
      updated_at: new Date(stat.mtimeMs).toISOString(),
      content: content || "No startup logs yet.",
    });
  } catch (error) {
    return res.status(200).json({
      service,
      exists: false,
      path: primaryLogPath,
      size_bytes: 0,
      updated_at: null,
      content: "No startup logs yet.",
      warning: error?.message || "Unknown error",
    });
  }
}

import { spawn } from "child_process";
import { once } from "events";
import { createWriteStream } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

export const SNAPSHOT_FORMAT_FULL = "avsp.storage.snapshot.v1";
export const SNAPSHOT_FORMAT_VLM = "avsp.vlm.annotations.v1";
export const SNAPSHOT_FORMAT_EMBEDDINGS = "avsp.embedder.annotations.v1";

export const SNAPSHOT_KIND_FULL = "full";
export const SNAPSHOT_KIND_VLM = "vlm";
export const SNAPSHOT_KIND_EMBEDDINGS = "embeddings";

export function masterEndpoint() {
  return (process.env.MASTER_ENDPOINT || "http://localhost:9002").replace(/\/$/, "");
}

export function chunkArray(values, chunkSize) {
  const size = Math.max(1, Number(chunkSize || 1));
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

export async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function readMasterJson(pathname, init = {}) {
  const response = await fetch(`${masterEndpoint()}${pathname}`, init);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message = payload?.detail || payload?.error || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function buildSnapshotFilename(kind, timestampIso) {
  const safeKind = String(kind || "snapshot")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  const safeTime = String(timestampIso || new Date().toISOString()).replace(/[:.]/g, "-");
  return `avsp-${safeKind}-${safeTime}.tar.gz`;
}

export async function createTempDir(prefix = "avsp-transfer-") {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function cleanupTempDir(dirPath) {
  if (!dirPath) {
    return;
  }
  await rm(dirPath, { recursive: true, force: true });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim() || `${command} exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

export async function packDirectoryToTarGz(sourceDir, archivePath) {
  await runCommand("tar", ["-czf", archivePath, "-C", sourceDir, "."]);
}

export async function extractTarGzToDirectory(archivePath, targetDir) {
  await runCommand("tar", ["-xzf", archivePath, "-C", targetDir]);
}

export async function writeRequestToFile(req, filePath, maxBytes) {
  const limit = Math.max(1, Number(maxBytes || 1));
  const output = createWriteStream(filePath, { flags: "w" });
  let total = 0;

  try {
    for await (const chunk of req) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > limit) {
        const error = new Error(`Snapshot payload exceeds limit (${limit} bytes)`);
        error.status = 413;
        req.destroy();
        throw error;
      }
      if (!output.write(piece)) {
        await once(output, "drain");
      }
    }
    await new Promise((resolve, reject) => {
      output.end((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } catch (error) {
    output.destroy();
    throw error;
  }

  return total;
}

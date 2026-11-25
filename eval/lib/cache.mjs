import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../config.mjs";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function contentHash(payload) {
  return crypto.createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function getCached(namespace, keyPayload) {
  const hash = contentHash(keyPayload);
  const file = path.join(CACHE_DIR, namespace, `${hash}.json`);
  if (!fs.existsSync(file)) return { hit: false, hash, file, value: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { hit: true, hash, file, value: parsed.value };
  } catch {
    return { hit: false, hash, file, value: null };
  }
}

export function setCached(namespace, keyPayload, value, meta = {}) {
  const hash = contentHash(keyPayload);
  const file = path.join(CACHE_DIR, namespace, `${hash}.json`);
  atomicWriteJson(file, {
    hash,
    namespace,
    cachedAt: new Date().toISOString(),
    meta,
    value,
  });
  return { hash, file };
}

export async function withCache(namespace, keyPayload, computeFn, meta = {}) {
  const existing = getCached(namespace, keyPayload);
  if (existing.hit) {
    return { hit: true, hash: existing.hash, value: existing.value };
  }
  const value = await computeFn();
  setCached(namespace, keyPayload, value, meta);
  return { hit: false, hash: existing.hash, value };
}

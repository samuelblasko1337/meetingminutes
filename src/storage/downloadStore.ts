import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 1000;

export type DownloadEntry = {
  id: string;
  fileName: string;
  content: Buffer;
  mimeType: string;
  ownerSub: string | null;
  createdAt: number;
  expiresAt: number;
};

const store = new Map<string, DownloadEntry>();

function cleanup(now: number) {
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt <= now) {
      store.delete(id);
    }
  }

  if (store.size <= MAX_ENTRIES) return;
  const entries = Array.from(store.values()).sort((a, b) => a.createdAt - b.createdAt);
  const excess = store.size - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) {
    const entry = entries[i];
    if (entry) store.delete(entry.id);
  }
}

export function putDownload(
  fileName: string,
  content: Buffer,
  mimeType: string,
  ownerSub: string | null,
  ttlMs?: number
): { id: string; expiresAt: number } {
  const now = Date.now();
  cleanup(now);
  const id = randomUUID();
  const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  const entry: DownloadEntry = {
    id,
    fileName,
    content,
    mimeType,
    ownerSub,
    createdAt: now,
    expiresAt: now + ttl
  };
  store.set(id, entry);
  return { id, expiresAt: entry.expiresAt };
}

export function getDownload(id: string): DownloadEntry | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(id);
    return null;
  }
  return entry;
}

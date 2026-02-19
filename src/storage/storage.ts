import type { AppConfig } from "../config.js";
import { getDownload, putDownload, type DownloadEntry } from "./downloadStore.js";
import { putObject } from "./objectStore.js";

export type StoragePutInput = {
  fileName: string;
  content: Buffer;
  mimeType: string;
  ownerSub: string | null;
  ttlMs?: number;
};

export type StoragePutResult =
  | { type: "local"; downloadId: string; expiresAt: number }
  | { type: "presigned"; url: string; expiresAt: number };

export type StorageBackend = {
  kind: "memory" | "objectstore";
  put: (input: StoragePutInput) => Promise<StoragePutResult>;
  get?: (id: string) => DownloadEntry | null;
};

export function createStorage(config: AppConfig): StorageBackend {
  if (config.DOWNLOAD_BACKEND === "objectstore") {
    return {
      kind: "objectstore",
      put: async (input: StoragePutInput) => {
        const ttlMs = input.ttlMs ?? config.DOWNLOAD_TTL_MS;
        const result = await putObject(
          {
            endpoint: config.OBJECTSTORE_ENDPOINT!,
            bucket: config.OBJECTSTORE_BUCKET!,
            accessKey: config.OBJECTSTORE_ACCESS_KEY!,
            secretKey: config.OBJECTSTORE_SECRET_KEY!,
            region: config.OBJECTSTORE_REGION ?? "us-east-1",
            usePathStyle: config.OBJECTSTORE_USE_PATH_STYLE ?? false,
            prefix: config.OBJECTSTORE_PREFIX,
            sessionToken: config.OBJECTSTORE_SESSION_TOKEN
          },
          {
            fileName: input.fileName,
            content: input.content,
            mimeType: input.mimeType,
            ttlMs
          }
        );
        return { type: "presigned", url: result.url, expiresAt: result.expiresAt };
      }
    };
  }

  return {
    kind: "memory",
    put: async (input: StoragePutInput) => {
      const ttlMs = input.ttlMs ?? config.DOWNLOAD_TTL_MS;
      const result = putDownload(input.fileName, input.content, input.mimeType, input.ownerSub, ttlMs);
      return { type: "local", downloadId: result.id, expiresAt: result.expiresAt };
    },
    get: (id: string) => getDownload(id)
  };
}

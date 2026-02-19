import { createHash, createHmac, randomUUID } from "node:crypto";
import { AppError } from "../utils/errors.js";

type ObjectStoreConfig = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  usePathStyle: boolean;
  prefix?: string;
  sessionToken?: string;
};

type PutObjectInput = {
  fileName: string;
  content: Buffer;
  mimeType: string;
  ttlMs: number;
};

type PutObjectResult = {
  url: string;
  expiresAt: number;
  key: string;
};

function encodeRFC3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildCanonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => encodeRFC3986(decodeURIComponent(seg)))
    .join("/");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string, encoding?: "hex"): Buffer | string {
  const out = createHmac("sha256", key).update(data);
  return encoding ? out.digest(encoding) : out.digest();
}

function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp) as Buffer;
  const kRegion = hmac(kDate, region) as Buffer;
  const kService = hmac(kRegion, service) as Buffer;
  return hmac(kService, "aws4_request") as Buffer;
}

function canonicalQuery(params: Array<[string, string]>): string {
  const encoded = params.map(([k, v]) => [encodeRFC3986(k), encodeRFC3986(v)] as const);
  encoded.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function presignUrl(opts: {
  method: string;
  url: URL;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  expiresInSec: number;
  sessionToken?: string;
}): string {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;

  const params: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${opts.accessKey}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(opts.expiresInSec)],
    ["X-Amz-SignedHeaders", "host"]
  ];
  if (opts.sessionToken) {
    params.push(["X-Amz-Security-Token", opts.sessionToken]);
  }
  opts.url.searchParams.forEach((value, key) => {
    params.push([key, value]);
  });

  const canonicalUri = buildCanonicalUri(opts.url.pathname);
  const query = canonicalQuery(params);
  const canonicalHeaders = `host:${opts.url.host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const signingKey = getSignatureKey(opts.secretKey, dateStamp, opts.region, opts.service);
  const signature = hmac(signingKey, stringToSign, "hex") as string;
  const finalQuery = `${query}&X-Amz-Signature=${signature}`;

  return `${opts.url.protocol}//${opts.url.host}${canonicalUri}?${finalQuery}`;
}

function buildObjectUrl(cfg: ObjectStoreConfig, key: string): URL {
  const endpoint = new URL(cfg.endpoint);
  if (cfg.usePathStyle) {
    return new URL(`/${cfg.bucket}/${key}`, endpoint.origin);
  }
  const host = `${cfg.bucket}.${endpoint.host}`;
  return new URL(`${endpoint.protocol}//${host}/${key}`);
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return "";
  const trimmed = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

export async function putObject(cfg: ObjectStoreConfig, input: PutObjectInput): Promise<PutObjectResult> {
  const prefix = normalizePrefix(cfg.prefix);
  const key = `${prefix}${randomUUID()}__${input.fileName}`;
  const putUrl = buildObjectUrl(cfg, key);
  const getUrl = buildObjectUrl(cfg, key);

  const putSignedUrl = presignUrl({
    method: "PUT",
    url: putUrl,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region,
    service: "s3",
    expiresInSec: 300,
    sessionToken: cfg.sessionToken
  });

  let putRes: Response;
  try {
    const body = Uint8Array.from(input.content).buffer;
    putRes = await fetch(putSignedUrl, {
      method: "PUT",
      headers: { "content-type": input.mimeType },
      body
    });
  } catch (err) {
    throw new AppError(502, "BadRequest", "Object store upload failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  if (!putRes.ok) {
    throw new AppError(502, "BadRequest", "Object store upload failed", {
      status: putRes.status,
      statusText: putRes.statusText
    });
  }

  const expiresInSec = Math.min(Math.max(Math.ceil(input.ttlMs / 1000), 1), 60 * 60 * 24 * 7);
  const signedGetUrl = presignUrl({
    method: "GET",
    url: getUrl,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region,
    service: "s3",
    expiresInSec,
    sessionToken: cfg.sessionToken
  });

  return {
    url: signedGetUrl,
    expiresAt: Date.now() + expiresInSec * 1000,
    key
  };
}

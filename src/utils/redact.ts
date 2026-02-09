// FILE: src/utils/redact.ts
export function redactValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  // defensively avoid logging anything that looks like a bearer token
  return v.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
}

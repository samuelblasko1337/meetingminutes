// FILE: src/log.ts
import pino from "pino";
import { redactValue } from "./utils/redact.js";

export function createLogger(level: "debug" | "info" | "warn" | "error") {
  // log to stderr so stdio transport stays clean
  return pino(
    {
      level,
      base: null,
      messageKey: "msg",
      redact: {
        paths: [
          "CLIENT_SECRET",
          "req.headers.authorization",
          "req.headers.Authorization",
          "*.authorization",
          "*.Authorization"
        ],
        censor: "[REDACTED]"
      },
      serializers: {
        err: (e) => ({
          type: e?.name,
          message: redactValue(e?.message),
          stack: level === "debug" ? redactValue(e?.stack) : undefined
        })
      }
    },
    pino.destination({ fd: 2 })
  );
}

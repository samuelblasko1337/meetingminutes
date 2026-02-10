// FILE: src/utils/errors.ts
import type { ZodError } from "zod";

export type AppErrorCode =
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "ValidationError"
  | "TooManyRequests"
  | "GraphError"
  | "Conflict"
  | "BadRequest"
  | "PayloadTooLarge"
  | "InternalError";

export class AppError extends Error {
  public readonly status: number;
  public readonly code: AppErrorCode;
  public readonly details?: unknown;

  constructor(status: number, code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function zodToValidationDetails(err: ZodError) {
  return err.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message
  }));
}

export function asToolErrorPayload(toolName: string, err: unknown) {
  if (err instanceof AppError) {
    return {
      error: {
        status: err.status,
        code: err.code,
        message: err.message,
        toolName,
        details: err.details ?? null
      }
    };
  }

  return {
    error: {
      status: 500,
      code: "InternalError",
      message: "Unexpected server error",
      toolName,
      details: null
    }
  };
}

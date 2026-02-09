// FILE: src/graph/retryAfterMiddleware.ts
import type { Context, Middleware } from "@microsoft/microsoft-graph-client";
import { sleepMs } from "../utils/sleep.js";

type RetryAfterOptions = {
  maxRetries: number; // total retries (not counting the first attempt)
  baseDelayMs: number; // used when Retry-After missing
  maxDelayMs: number;
};

export class RetryAfterMiddleware implements Middleware {
  private nextMiddleware?: Middleware;
  private readonly opts: RetryAfterOptions;

  constructor(opts?: Partial<RetryAfterOptions>) {
    this.opts = {
      maxRetries: opts?.maxRetries ?? 5,
      baseDelayMs: opts?.baseDelayMs ?? 500,
      maxDelayMs: opts?.maxDelayMs ?? 30_000
    };
  }

  public setNext(next: Middleware): void {
    this.nextMiddleware = next;
  }

  public async execute(context: Context): Promise<void> {
    if (!this.nextMiddleware) throw new Error("RetryAfterMiddleware missing next");

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      await this.nextMiddleware.execute(context);

      const res = context.response;
      if (!res) return;

      const status = res.status;

      // treat 429 + 503 as retryable throttling
      if (status !== 429 && status !== 503) return;

      if (attempt >= this.opts.maxRetries) return;

      const retryAfterHeader = res.headers.get("Retry-After") ?? res.headers.get("retry-after");
      let delayMs: number | null = null;

      if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
          delayMs = Math.min(seconds * 1000, this.opts.maxDelayMs);
        }
      }

      if (delayMs === null) {
        // exponential backoff with jitter
        const exp = this.opts.baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 250);
        delayMs = Math.min(exp + jitter, this.opts.maxDelayMs);
      }

      await sleepMs(delayMs);
      // loop retries by re-executing the rest of the chain
      // NOTE: request body must be reusable (we only send Buffer/Uint8Array)
    }
  }
}

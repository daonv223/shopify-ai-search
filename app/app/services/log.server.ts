// Structured logging + the single error-reporting seam (task 5.3).
//
// One JSON line per op — `{ level, ts, shop, op, ok, ms?, err?, ... }` —
// extending the Phase 4 timing line's fields (storefront-search.server.ts
// `logTiming`). Every ad-hoc console.log/console.error in the ops path funnels
// through here so a pilot can bolt on Sentry at the one `reportError` seam
// without touching call sites. No APM vendor in v1 (spec §2, §3.3).

export type LogLevel = "info" | "warn" | "error";

export interface ErrorDetail {
  message: string;
  name?: string;
  stack?: string;
}

export interface LogFields {
  op: string;
  ok: boolean;
  level?: LogLevel;
  shop?: string;
  ms?: number;
  err?: unknown;
  // any extra structured context (counts, ids, ...) is passed through verbatim
  [key: string]: unknown;
}

// Normalize any thrown value into a compact, JSON-safe detail. Stack is capped
// so a persisted WebhookEvent.error / SyncRun.error row stays small.
export function serializeError(err: unknown): ErrorDetail {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack?.slice(0, 2000),
    };
  }
  return { message: typeof err === "string" ? err : JSON.stringify(err) };
}

// Emit one structured log line. Level defaults from `ok` (ok → info, else
// error) but can be overridden (e.g. warn). `err` is serialized in place.
export function logEvent(fields: LogFields): void {
  const { level, err, ...rest } = fields;
  const resolved: LogLevel = level ?? (fields.ok ? "info" : "error");
  const line: Record<string, unknown> = {
    level: resolved,
    ts: new Date().toISOString(),
    ...rest,
  };
  if (err !== undefined) line.err = serializeError(err);
  (resolved === "error" ? console.error : console.log)(JSON.stringify(line));
}

// The error seam. Logs a structured error line and returns the serialized
// detail so callers can persist it (WebhookEvent.error, SyncRun.error). This is
// the one place a pilot wires an APM SDK.
export function reportError(
  op: string,
  err: unknown,
  context: { shop?: string } & Record<string, unknown> = {},
): ErrorDetail {
  const detail = serializeError(err);
  logEvent({ op, ok: false, level: "error", err, ...context });
  // seam: e.g. Sentry.captureException(err, { tags: { op, ...context } });
  return detail;
}

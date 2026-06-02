import type { RouteResult } from "@app/dev-dashboard/server/types";

/** Mirrors the middleware's `{ error: <message> }` wire shape. Errors have no
 * enumerable props, so the `.message` string form is load-bearing — do not
 * replace it with `{ error: err }` (that serializes to `{"error":{}}`). */
export function errorResult(err: unknown, status = 500): RouteResult {
    return { kind: "json", status, body: { error: err instanceof Error ? err.message : String(err) } };
}

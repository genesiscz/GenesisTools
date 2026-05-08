/**
 * Backwards-compatible alias for MemoryHttpRequestSink — Plan 03 documented
 * `MemoryHttpSink` as the test helper name; reuses the canonical impl.
 */

export type { HttpRequestEvent, HttpRequestSink } from "../lib/http-sink";
export { MemoryHttpRequestSink as MemoryHttpSink } from "../lib/http-sink";

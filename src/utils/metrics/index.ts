// The light door of `@genesiscz/utils/metrics`: record an event and the shapes. It loads no SQLite and no service;
// the store, the query builder, the service and its client are their own subpaths (`metrics/store`, `metrics/service`,
// `metrics/service-client`).
export { createMetricsRecorder, type MetricsRecorder, metrics } from "./client";
export { appendSpoolLines, SPOOL_VERSION, spoolDir, spoolLine } from "./spool";
export type * from "./types";

import { fileURLToPath } from "node:url";
import { checkoutCodeStamp } from "@genesiscz/utils/rpc/code-stamp";
import { z } from "zod";
import type { DrainResult } from "./spool";
import {
    type IngestResult,
    METRIC_AGGREGATES,
    type MetricCatalogEntry,
    type MetricCheckpoint,
    type MetricEventsResult,
    type MetricQueryResult,
    type SpoolFileState,
    WHERE_OPS,
} from "./types";

/**
 * The metrics service's JSON-RPC methods: one table of params schemas, and the result each answers. The service
 * (`service.ts`) answers each method through a handler table keyed by the same names, so a method without a handler
 * is a compile error.
 */
export const METRICS_PROTOCOL = 1;

/** The one subscription: every event the service takes in, optionally of one project and metric. */
export const METRICS_EVENT = "event";

/** The largest `ingest` batch. */
export const MAX_INGEST_EVENTS = 10_000;

const dimValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const callerSchema = z.object({
    tool: z.string().min(1),
    pid: z.number().int(),
    session: z.string().optional(),
    reason: z.string().optional(),
});

const filterSchema = z.object({
    project: z.string().min(1),
    metric: z.string().min(1),
    since: z.number().optional(),
    until: z.number().optional(),
    sinceCheckpoint: z.string().min(1).optional(),
    untilCheckpoint: z.string().min(1).optional(),
    where: z
        .array(
            z.object({
                dim: z.string(),
                op: z.enum(WHERE_OPS),
                value: z.union([dimValue, z.array(z.union([z.string(), z.number()]))]),
            })
        )
        .optional(),
    caller: callerSchema.optional(),
});

export const queryParamsSchema = filterSchema.extend({
    groupBy: z.array(z.string()).optional(),
    aggregates: z.array(z.enum(METRIC_AGGREGATES)).optional(),
    sort: z.object({ by: z.string(), descending: z.boolean() }).optional(),
    limit: z.number().int().positive().optional(),
});

export const eventsParamsSchema = filterSchema.extend({
    limit: z.number().int().positive().optional(),
    withCheckpoint: z.boolean().optional(),
});

/** A checkpoint to add or update; `checkCheckpoint` (`dims.ts`) checks the names, the time and the sizes. */
export const checkpointAddParamsSchema = z.object({
    project: z.string().min(1),
    name: z.string().min(1),
    at: z.union([z.number(), z.string()]).optional(),
    commit: z.string().optional(),
    repo: z.string().optional(),
    note: z.string().optional(),
    data: z.unknown().optional(),
});

export const ingestParamsSchema = z.object({
    events: z.array(z.unknown()).max(MAX_INGEST_EVENTS),
    /**
     * The file these events were read from (`import hooks-log`): `start` must be the offset the store holds for it, and
     * the events and `end` are written in one transaction, so a second import of the same lines adds nothing.
     */
    cursor: z
        .object({
            path: z.string().min(1),
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            lines: z.number().int().nonnegative(),
        })
        .optional(),
});

export const subscribeParamsSchema = z.object({
    events: z.array(z.literal(METRICS_EVENT)).optional(),
    project: z.string().min(1).optional(),
    metric: z.string().min(1).optional(),
    /** Each notification carries the checkpoint its event falls under. */
    withCheckpoint: z.boolean().optional(),
});

export const METRICS_METHODS = {
    define: z.object({
        project: z.string().min(1),
        metric: z.string().min(1),
        unit: z.string().optional(),
        description: z.string().optional(),
        dims: z.array(z.string()).optional(),
    }),
    ingest: ingestParamsSchema,
    query: queryParamsSchema,
    events: eventsParamsSchema,
    catalog: z.object({}),
    drain: z.object({}),
    status: z.object({}),
    prune: z.object({ before: z.number() }),
    "checkpoint.add": checkpointAddParamsSchema,
    /** Reads only, like `catalog`: it never drains the spool. */
    "checkpoint.list": z.object({ project: z.string().min(1).optional() }),
    "checkpoint.remove": z.object({ project: z.string().min(1), name: z.string().min(1) }),
} as const;

export type MetricsMethod = keyof typeof METRICS_METHODS;
export type MetricsParams<M extends MetricsMethod> = z.input<(typeof METRICS_METHODS)[M]>;

export interface MetricsStatus {
    pid: number;
    startedAt: string;
    db: string;
    events: number;
    percentiles: "native" | "window";
    spool: { dir: string; files: SpoolFileState[]; badLines: number; drains: number };
}

/** The answer of an `ingest` that named a cursor the store does not hold: nothing was written. */
export interface IngestCursorMismatch extends IngestResult {
    cursorMismatch: { stored: number };
}

export interface MetricsResults {
    define: MetricCatalogEntry;
    ingest: IngestResult | IngestCursorMismatch;
    query: MetricQueryResult;
    events: MetricEventsResult;
    catalog: MetricCatalogEntry[];
    drain: DrainResult;
    status: MetricsStatus;
    prune: { removed: number };
    "checkpoint.add": MetricCheckpoint;
    "checkpoint.list": MetricCheckpoint[];
    "checkpoint.remove": { removed: boolean };
}

export type MetricsResult<M extends MetricsMethod> = MetricsResults[M];

/** The notification of `event`: one event the service took in. */
export interface MetricsEventNotification {
    project: string;
    metric: string;
    at: number;
    value: number;
    dims: Record<string, string | number | boolean | null>;
    context?: unknown;
    door: MetricsDoor;
    /** For a subscription with `withCheckpoint`: the checkpoint the event falls under. */
    checkpoint?: string;
}

/** How an event reached the store: the `door` dim of the service's own `ingest.events`. */
export const METRICS_DOORS = ["spool", "rpc", "import"] as const;
export type MetricsDoor = (typeof METRICS_DOORS)[number];

/** The `event` notification as a client reads it. */
export const eventNotificationSchema = z.object({
    project: z.string(),
    metric: z.string(),
    at: z.number(),
    value: z.number(),
    dims: z.record(z.string(), dimValue),
    context: z.unknown().optional(),
    door: z.enum(METRICS_DOORS),
    checkpoint: z.string().optional(),
});

/** The checkout this code runs from; a module of it that changed makes the service exit. */
export function metricsSourceRoot(): string {
    return fileURLToPath(new URL("../../../", import.meta.url));
}

export function metricsCodeStamp(root = metricsSourceRoot()): string {
    return checkoutCodeStamp(root);
}

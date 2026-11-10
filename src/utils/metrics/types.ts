/** A dim value: what an event is grouped and filtered by. */
export type DimValue = string | number | boolean | null;

export type Dims = Record<string, DimValue>;

/** What a producer hands over. One line of the spool, one element of an `ingest` call. */
export interface MetricEvent {
    /** The namespace: `agent-context`. */
    project: string;
    /** `hook.injection`. */
    metric: string;
    /** Epoch ms or ISO; the ingest time when absent. */
    at?: number | string;
    /** The measured number (chars, ms, count). */
    value: number;
    dims?: Dims;
    /** Free JSON kept with the event, never grouped. */
    context?: unknown;
}

/** An event as the store keeps it: names checked, `at` resolved to epoch ms. */
export interface StoredEvent {
    project: string;
    metric: string;
    at: number;
    value: number;
    dims: Dims;
    context?: unknown;
    /** `context` as JSON text, when the check already wrote it. */
    contextJson?: string;
}

/** Optional declaration. An event for an unknown project or metric creates both, so a producer needs no setup. */
export interface MetricDefinition {
    project: string;
    metric: string;
    /** `chars`, `ms`, `tokens`, `count`. */
    unit?: string;
    description?: string;
    /** Declared dims get an index; any other dim still works, only slower. */
    dims?: string[];
}

export const METRIC_AGGREGATES = ["count", "sum", "avg", "min", "max", "p50", "p90", "p99"] as const;
export type MetricAggregate = (typeof METRIC_AGGREGATES)[number];

export const WHERE_OPS = ["=", "!=", "in", "glob"] as const;
export type WhereOp = (typeof WHERE_OPS)[number];

export interface MetricWhere {
    dim: string;
    op: WhereOp;
    value: DimValue | Array<string | number>;
}

/** A time bucket a query can group by, beside dim names. Buckets are UTC. */
export const TIME_GROUPS = { "time:hour": 3_600_000, "time:day": 86_400_000 } as const;
export type TimeGroup = keyof typeof TIME_GROUPS;

/** Who asks, for the service's own `query.ms` metric. */
export interface MetricCaller {
    tool: string;
    pid: number;
    session?: string;
    reason?: string;
}

/** The filters `query` and `events` share. */
export interface MetricFilter {
    project: string;
    metric: string;
    /** Epoch ms, inclusive. */
    since?: number;
    /** Epoch ms, exclusive. */
    until?: number;
    where?: MetricWhere[];
    caller?: MetricCaller;
}

export interface MetricQuery extends MetricFilter {
    /** Dim names, plus `time:hour` or `time:day`. */
    groupBy?: string[];
    /** Default count and sum. */
    aggregates?: MetricAggregate[];
    /** An aggregate or a group key; default the sum, descending. */
    sort?: { by: string; descending: boolean };
    /** Default 50. */
    limit?: number;
}

export interface MetricEventsQuery extends MetricFilter {
    /** Default 20; the newest first. */
    limit?: number;
}

/** One group of a query: its key per group name, and each aggregate asked. */
export interface MetricQueryRow {
    group: Record<string, DimValue>;
    values: Partial<Record<MetricAggregate, number | null>>;
}

export interface MetricQueryResult {
    project: string;
    metric: string;
    groupBy: string[];
    aggregates: MetricAggregate[];
    rows: MetricQueryRow[];
    /** False when the metric does not exist yet: no rows, no error. */
    known: boolean;
    ms: number;
}

/** One single event with its context, as `events` answers it. */
export interface MetricEventRow {
    id: number;
    at: number;
    value: number;
    dims: Dims;
    context?: unknown;
}

export interface MetricEventsResult {
    project: string;
    metric: string;
    known: boolean;
    rows: MetricEventRow[];
}

export interface MetricCatalogEntry {
    project: string;
    metric: string;
    unit?: string;
    description?: string;
    dims: string[];
    count: number;
    first?: number;
    last?: number;
}

/** How far one spool or import file was read. */
export interface SpoolFileState {
    path: string;
    offset: number;
    lines: number;
    updatedAt: number;
}

export interface IngestResult {
    accepted: number;
    rejected: number;
    /** The first few reasons, with the index of the event each one refused. */
    reasons: Array<{ index: number; reason: string }>;
}

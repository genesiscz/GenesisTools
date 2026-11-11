import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import { type ServiceEntry, type ServiceHost, startServiceHost } from "@genesiscz/utils/rpc/service-host";
import type { RpcConnection } from "@genesiscz/utils/rpc/socket-server";
import type { z } from "zod";
import { type CheckpointMark, checkpointAt } from "./checkpoints";
import { checkEvent, MetricsInputError } from "./dims";
import {
    METRICS_EVENT,
    METRICS_METHODS,
    METRICS_PROTOCOL,
    type MetricsDoor,
    type MetricsEventNotification,
    type MetricsMethod,
    type MetricsResult,
    metricsCodeStamp,
    subscribeParamsSchema,
} from "./protocol";
import { drainSpool, metricsDbPath, metricsServiceDir, spoolDir } from "./spool";
import type { PercentileMode } from "./sql";
import { MetricsStore } from "./store";
import type { Dims, IngestResult, StoredEvent } from "./types";

const { log } = logger.scoped("metrics-service");
const prof = profiler.scope("metrics");

/** The service exits after this long with no connection and no call. */
export const METRICS_SERVICE_IDLE_MS = 10 * 60_000;

/** The safety drain behind the spool folder watch. */
const DRAIN_EVERY_MS = 30_000;

/** A burst of appends drains once, this long after the last change. */
const DRAIN_SETTLE_MS = 200;

/** The project of the service's own measurements: `query.ms`, `ingest.events`, `ingest.rejected`, `drain.ms`. */
export const SELF_PROJECT = "metrics";

const MAX_REASONS = 10;

interface ConnectionState {
    id: number;
    /** The subscription's filter; undefined until the connection subscribes. */
    filter?: { project?: string; metric?: string; withCheckpoint?: boolean };
}

export interface MetricsServiceOptions {
    dir?: string;
    dbPath?: string;
    spoolDir?: string;
    /** 0 never exits for idleness. */
    idleMs?: number;
    checkEveryMs?: number;
    /** The checkout whose loaded modules a code change is read from; tests pass none. */
    sourceRoot?: string;
    code?: string;
    rivalWaitMs?: number;
    /** Watch the spool folder (default true); a test drains by `drain` calls. */
    watch?: boolean;
    /** The safety drain's period; 0 for none. */
    drainEveryMs?: number;
    percentiles?: PercentileMode;
    onStopped?: (reason: string) => void;
}

export interface MetricsService {
    readonly entry: ServiceEntry;
    stop(reason: string): void;
    readonly stopped: Promise<string>;
}

export type MetricsServiceStart =
    | { status: "started"; service: MetricsService }
    | { status: "running"; entry: ServiceEntry };

/** One method's handler behind its params check: a refused param is an invalid-params error naming the field. */
interface Handler<R> {
    run(params: unknown): R;
}

type Handlers = { [M in MetricsMethod]: Handler<MetricsResult<M>> };

function invalid(message: string): RpcError {
    return new RpcError(JSON_RPC_ERRORS.invalidParams, message);
}

function handler<S extends z.ZodType, R>(name: string, schema: S, run: (params: z.output<S>) => R): Handler<R> {
    return {
        run(params) {
            const parsed = schema.safeParse(params ?? {});

            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw invalid(`${name}: ${issue?.path.join(".") || "params"}: ${issue?.message}`);
            }

            try {
                return run(parsed.data);
            } catch (error) {
                throw error instanceof MetricsInputError ? invalid(`${name}: ${error.message}`) : error;
            }
        },
    };
}

function isMethod(method: string): method is MetricsMethod {
    return Object.hasOwn(METRICS_METHODS, method);
}

/**
 * Starts the metrics service in this process (`tools metrics serve`): the only process that opens the metrics
 * database while it runs. It drains the spool at start, when the spool folder changes, and before each `query` and
 * `events`. A second start finds the first and answers `running`.
 */
export async function startMetricsService(options: MetricsServiceOptions = {}): Promise<MetricsServiceStart> {
    const dbPath = options.dbPath ?? metricsDbPath();
    const spool = options.spoolDir ?? spoolDir();
    const startedAt = new Date().toISOString();
    let store: MetricsStore | undefined;
    let host: ServiceHost<ConnectionState> | undefined;
    let lastId = 0;
    let badLines = 0;
    let drains = 0;

    const storeNow = (): MetricsStore => {
        store ??= MetricsStore.open({
            path: dbPath,
            ...(options.percentiles ? { percentiles: options.percentiles } : {}),
        });
        return store;
    };

    const self = (metric: string, value: number, dims: Dims): void => {
        try {
            storeNow().insert([{ project: SELF_PROJECT, metric, at: Date.now(), value, dims }]);
        } catch (error) {
            log.debug({ error, metric }, "the metrics service could not record its own measurement");
        }
    };

    const emit = (events: readonly StoredEvent[], door: MetricsDoor): void => {
        const listening = host?.connections.filter((connection) => connection.events !== undefined) ?? [];

        if (listening.length === 0) {
            return;
        }

        const labelled = listening.some((connection) => connection.state.filter?.withCheckpoint === true);
        const marks = new Map<string, CheckpointMark[]>();
        const labelOf = (event: StoredEvent): string => {
            let held = marks.get(event.project);

            if (!held) {
                held = storeNow()
                    .checkpoints(event.project)
                    .map((checkpoint) => ({ name: checkpoint.name, at: checkpoint.at }));
                marks.set(event.project, held);
            }

            return checkpointAt(held, event.at);
        };

        for (const event of events) {
            const notification: MetricsEventNotification = {
                project: event.project,
                metric: event.metric,
                at: event.at,
                value: event.value,
                dims: event.dims,
                ...(event.context === undefined ? {} : { context: event.context }),
                door,
            };
            const matches = (connection: RpcConnection<ConnectionState>, withCheckpoint: boolean): boolean => {
                const filter = connection.state.filter;
                return (
                    (filter?.withCheckpoint === true) === withCheckpoint &&
                    (!filter?.project || filter.project === event.project) &&
                    (!filter?.metric || filter.metric === event.metric)
                );
            };
            host?.emit(METRICS_EVENT, { ...notification }, (connection) => matches(connection, false));

            if (labelled) {
                host?.emit(METRICS_EVENT, { ...notification, checkpoint: labelOf(event) }, (connection) =>
                    matches(connection, true)
                );
            }
        }
    };

    const drain = () =>
        prof.measure("drain", () => {
            const started = performance.now();
            const result = drainSpool(storeNow(), { dir: spool, onEvents: (events) => emit(events, "spool") });
            drains += 1;
            badLines += result.bad;

            if (result.lines > 0) {
                self("drain.ms", performance.now() - started, { files: result.files });
                self("ingest.events", result.events, { door: "spool" });

                if (result.bad > 0) {
                    self("ingest.rejected", result.bad, { door: "spool" });
                }
            }

            return result;
        });

    const ingest = (params: z.output<typeof METRICS_METHODS.ingest>): MetricsResult<"ingest"> =>
        prof.measure("ingest", () => {
            const now = Date.now();
            const accepted: StoredEvent[] = [];
            const reasons: IngestResult["reasons"] = [];
            let rejected = 0;

            for (const [index, raw] of params.events.entries()) {
                const check = checkEvent(raw, now);

                if (check.ok) {
                    accepted.push(check.event);
                    continue;
                }

                rejected += 1;

                if (reasons.length < MAX_REASONS) {
                    reasons.push({ index, reason: check.reason });
                }
            }

            const door: MetricsDoor = params.cursor ? "import" : "rpc";

            if (params.cursor) {
                const held = storeNow().spoolFile(params.cursor.path);
                const stored = held?.offset ?? 0;

                if (stored !== params.cursor.start) {
                    log.info(
                        { path: params.cursor.path, stored, start: params.cursor.start },
                        "an import batch does not start where the store's offset is; nothing written"
                    );
                    return { accepted: 0, rejected: 0, reasons: [], cursorMismatch: { stored } };
                }

                storeNow().insert(accepted, {
                    path: params.cursor.path,
                    offset: params.cursor.end,
                    lines: (held?.lines ?? 0) + params.cursor.lines,
                });
            } else {
                storeNow().insert(accepted);
            }

            emit(accepted, door);
            self("ingest.events", accepted.length, { door });

            if (rejected > 0) {
                self("ingest.rejected", rejected, { door });
            }

            return { accepted: accepted.length, rejected, reasons };
        });

    const recordRead = (read: {
        method: "query" | "events";
        params: { project: string; metric: string; caller?: { tool: string } };
        ms: number;
        groupBy: string;
    }): void =>
        self("query.ms", read.ms, {
            method: read.method,
            caller: read.params.caller?.tool ?? "unknown",
            project: read.params.project,
            metric: read.params.metric,
            groupBy: read.groupBy,
        });

    let watcher: FSWatcher | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let safety: ReturnType<typeof setInterval> | undefined;

    const stopWatching = (): void => {
        watcher?.close();
        watcher = undefined;
        clearTimeout(settle);
        clearInterval(safety);
    };

    const handlers: Handlers = {
        define: handler("define", METRICS_METHODS.define, (params) => storeNow().define(params)),
        ingest: handler("ingest", METRICS_METHODS.ingest, ingest),
        query: handler("query", METRICS_METHODS.query, (params) => {
            drain();
            const result = prof.measure("query", () => storeNow().query(params));
            recordRead({ method: "query", params, ms: result.ms, groupBy: result.groupBy.join(",") || "none" });
            return result;
        }),
        events: handler("events", METRICS_METHODS.events, (params) => {
            drain();
            const started = performance.now();
            const result = prof.measure("events", () => storeNow().events(params));
            recordRead({ method: "events", params, ms: performance.now() - started, groupBy: "none" });
            return result;
        }),
        // `list` and `status` are diagnostics: they answer what the store holds and never drain the spool.
        catalog: handler("catalog", METRICS_METHODS.catalog, () => storeNow().catalog()),
        drain: handler("drain", METRICS_METHODS.drain, () => drain()),
        status: handler("status", METRICS_METHODS.status, () => ({
            pid: process.pid,
            startedAt,
            db: dbPath,
            events: storeNow().eventCount(),
            percentiles: storeNow().percentiles,
            spool: { dir: spool, files: storeNow().spoolFiles(), badLines, drains },
        })),
        prune: handler("prune", METRICS_METHODS.prune, (params) => ({ removed: storeNow().prune(params.before) })),
        "checkpoint.add": handler("checkpoint.add", METRICS_METHODS["checkpoint.add"], (params) =>
            storeNow().addCheckpoint(params)
        ),
        // Reads only, like `catalog`: a checkpoint still in the spool shows after the next drain.
        "checkpoint.list": handler("checkpoint.list", METRICS_METHODS["checkpoint.list"], (params) =>
            storeNow().checkpoints(params.project)
        ),
        "checkpoint.remove": handler("checkpoint.remove", METRICS_METHODS["checkpoint.remove"], (params) => ({
            removed: storeNow().removeCheckpoint(params.project, params.name),
        })),
    };

    const start = await startServiceHost<ConnectionState>({
        dir: options.dir ?? metricsServiceDir(),
        label: "metrics service",
        logScope: "metrics-service",
        protocol: METRICS_PROTOCOL,
        code: options.code ?? metricsCodeStamp(),
        state: () => ({ id: ++lastId }),
        call: async ({ method, params }) => {
            if (!isMethod(method)) {
                throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `unknown method ${method}`);
            }

            return handlers[method].run(params);
        },
        onSubscribe: (connection: RpcConnection<ConnectionState>, params) => {
            const parsed = subscribeParamsSchema.safeParse(params ?? {});

            // A filter that does not read would widen the subscription to every metric; it is refused instead.
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw invalid(`subscribe: ${issue?.path.join(".") || "params"}: ${issue?.message}`);
            }

            connection.state.filter = {
                ...(parsed.data.project ? { project: parsed.data.project } : {}),
                ...(parsed.data.metric ? { metric: parsed.data.metric } : {}),
                ...(parsed.data.withCheckpoint ? { withCheckpoint: true } : {}),
            };
        },
        idleMs: options.idleMs ?? METRICS_SERVICE_IDLE_MS,
        checkEveryMs: options.checkEveryMs,
        sourceRoot: options.sourceRoot,
        rivalWaitMs: options.rivalWaitMs,
        onStopping: () => {
            stopWatching();
        },
        onStopped: (reason) => {
            store?.close();
            store = undefined;
            options.onStopped?.(reason);
        },
    });

    if (start.status === "running") {
        return start;
    }

    host = start.host;

    const drainSafely = (why: string): void => {
        try {
            drain();
        } catch (error) {
            log.warn({ error, why }, "a metrics spool drain failed");
        }
    };

    drainSafely("start");

    if (options.watch !== false) {
        try {
            mkdirSync(spool, { recursive: true });
            watcher = watch(spool, { persistent: false }, () => {
                clearTimeout(settle);
                settle = setTimeout(() => drainSafely("spool changed"), DRAIN_SETTLE_MS);
            });
            watcher.on("error", (error) =>
                log.warn({ error, spool }, "the metrics spool watch failed; the timer drains")
            );
        } catch (error) {
            log.warn({ error, spool }, "the metrics spool folder is not watched; the timer drains");
        }
    }

    const every = options.drainEveryMs ?? DRAIN_EVERY_MS;

    if (every > 0) {
        safety = setInterval(() => drainSafely("timer"), every);
        safety.unref?.();
    }

    return {
        status: "started",
        service: { entry: start.host.entry, stop: start.host.stop, stopped: start.host.stopped },
    };
}

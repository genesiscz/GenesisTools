import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { applyPragmas } from "@genesiscz/utils/database/pragmas";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { assertDimName, assertName, isDimName } from "./dims";
import { METRICS_MIGRATION_SCOPE, METRICS_MIGRATIONS } from "./migrations";
import { type AggregateOptions, buildAggregateSql, buildEventsSql, dimIndexSql, type PercentileMode } from "./sql";
import type {
    Dims,
    MetricCatalogEntry,
    MetricDefinition,
    MetricEventRow,
    MetricEventsQuery,
    MetricEventsResult,
    MetricQuery,
    MetricQueryResult,
    MetricQueryRow,
    SpoolFileState,
    StoredEvent,
} from "./types";

const { log } = logger.scoped("metrics-store");

/** How far a file was read once a batch of its lines is in: written in the same transaction as the events. */
export interface ReadCursor {
    path: string;
    offset: number;
    lines: number;
}

export interface MetricsStoreOptions {
    /** The database file, or `:memory:`. */
    path: string;
    /** Forces how percentiles are computed; by default SQLite's `percentile()` when this build has it. */
    percentiles?: PercentileMode;
}

interface MetricRow {
    id: number;
    project: string;
    name: string;
    unit: string | null;
    description: string | null;
    dims_json: string;
}

function dimsOf(text: string): Dims {
    const parsed: unknown = SafeJSON.parse(text, { strict: true });

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
    }

    return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, groupValue(value)]));
}

function declaredDims(text: string): string[] {
    const parsed: unknown = SafeJSON.parse(text, { strict: true });
    return Array.isArray(parsed)
        ? parsed.filter((dim): dim is string => typeof dim === "string" && isDimName(dim))
        : [];
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function groupValue(value: unknown): string | number | boolean | null {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function probePercentile(db: Database): PercentileMode {
    try {
        db.query("SELECT percentile(1, 50) AS p").get();
        return "native";
    } catch (error) {
        log.debug({ error }, "this SQLite has no percentile(); percentiles use a window function");
        return "window";
    }
}

/**
 * The metrics database: one SQLite file per machine, opened only by the metrics service (and by tests and the
 * benchmark). Events are the source of truth; every statistic is a query over them, built by `sql.ts`.
 */
export class MetricsStore {
    readonly percentiles: PercentileMode;
    private readonly ids = new Map<string, number>();
    private readonly insertEvent: Statement;
    private readonly writeCursor: Statement;

    private constructor(
        private readonly db: Database,
        readonly path: string,
        percentiles: PercentileMode | undefined
    ) {
        this.percentiles = percentiles ?? probePercentile(db);
        this.insertEvent = db.prepare(
            "INSERT INTO events (metric_id, at, value, dims, context) VALUES (?, ?, ?, ?, ?)"
        );
        this.writeCursor = db.prepare(
            "INSERT INTO spool_files (path, offset, lines, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, lines = excluded.lines, updated_at = excluded.updated_at"
        );
    }

    static open(options: MetricsStoreOptions): MetricsStore {
        if (options.path !== ":memory:") {
            mkdirSync(dirname(options.path), { recursive: true });
        }

        const db = new Database(options.path, { create: true });
        applyPragmas(db, { journalMode: "WAL", busyTimeoutMs: 5_000, synchronous: "NORMAL" });
        runMigrations(db, METRICS_MIGRATIONS, { tableName: METRICS_MIGRATION_SCOPE });
        log.debug({ path: options.path }, "metrics store opened");
        return new MetricsStore(db, options.path, options.percentiles);
    }

    /**
     * The store opened to read only, for a diagnostic (`list`, `status`) while no service runs: no migration, no
     * pragma write, no file made. Undefined when the file does not exist or holds no metrics tables yet.
     */
    static openReadOnly(path: string): MetricsStore | undefined {
        if (!existsSync(path)) {
            return undefined;
        }

        const db = new Database(path, { readonly: true });
        const tables = db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'metrics', 'projects', 'spool_files')"
            )
            .all();

        if (tables.length < 4) {
            db.close();
            return undefined;
        }

        log.debug({ path }, "metrics store opened read-only");
        return new MetricsStore(db, path, undefined);
    }

    close(): void {
        this.db.close();
    }

    /** The metric's id; undefined when it does not exist. */
    private findMetricId(project: string, metric: string): number | undefined {
        const key = `${project}\u0000${metric}`;
        const cached = this.ids.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const found = this.db
            .query<{ id: number }, [string, string]>(
                "SELECT metrics.id AS id FROM metrics JOIN projects ON projects.id = metrics.project_id WHERE projects.name = ? AND metrics.name = ?"
            )
            .get(project, metric);

        if (found) {
            this.ids.set(key, found.id);
        }

        return found?.id;
    }

    /** The metric's id, creating the project and the metric when they are new. */
    private ensureMetricId(project: string, metric: string): number {
        const existing = this.findMetricId(project, metric);

        if (existing !== undefined) {
            return existing;
        }

        const key = `${project}\u0000${metric}`;
        const now = Date.now();
        this.db.run("INSERT INTO projects (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING", [
            project,
            now,
        ]);
        const projectRow = this.db
            .query<{ id: number }, [string]>("SELECT id FROM projects WHERE name = ?")
            .get(project);

        if (!projectRow) {
            throw new Error(`metrics project ${project} was not created`);
        }

        const inserted = this.db
            .query<{ id: number }, [number, string, number]>(
                "INSERT INTO metrics (project_id, name, created_at) VALUES (?, ?, ?) RETURNING id"
            )
            .get(projectRow.id, metric, now);

        if (!inserted) {
            throw new Error(`metric ${project}/${metric} was not created`);
        }

        log.debug({ project, metric, id: inserted.id }, "metric created");
        this.ids.set(key, inserted.id);
        return inserted.id;
    }

    /** Declares a metric: its unit, description and the dims that get an index. A later call adds dims. */
    define(definition: MetricDefinition): MetricCatalogEntry {
        const project = assertName("project", definition.project);
        const metric = assertName("metric", definition.metric);
        const dims = (definition.dims ?? []).map(assertDimName);

        this.db.transaction(() => {
            const id = this.ensureMetricId(project, metric);
            const row = this.db
                .query<{ dims_json: string }, [number]>("SELECT dims_json FROM metrics WHERE id = ?")
                .get(id);
            const merged = [...new Set([...declaredDims(row?.dims_json ?? "[]"), ...dims])];
            this.db.run(
                "UPDATE metrics SET unit = COALESCE(?, unit), description = COALESCE(?, description), dims_json = ? WHERE id = ?",
                [
                    definition.unit ?? null,
                    definition.description ?? null,
                    SafeJSON.stringify(merged, { strict: true }),
                    id,
                ]
            );

            for (const dim of merged) {
                this.db.run(dimIndexSql(id, dim));
            }
        })();

        log.debug({ project, metric, dims }, "metric defined");
        const entry = this.catalog().find((each) => each.project === project && each.metric === metric);

        if (!entry) {
            throw new Error(`metric ${project}/${metric} is missing after define`);
        }

        return entry;
    }

    /**
     * Adds checked events in one transaction; with a cursor, the file's new read position is written in the same
     * transaction, so a crash or a second read never doubles an event.
     */
    insert(events: readonly StoredEvent[], cursor?: ReadCursor): number {
        const run = this.db.transaction(() => {
            for (const event of events) {
                const id = this.ensureMetricId(event.project, event.metric);
                const context =
                    event.context === undefined
                        ? null
                        : (event.contextJson ?? SafeJSON.stringify(event.context, { strict: true }));
                this.insertEvent.run(
                    id,
                    event.at,
                    event.value,
                    SafeJSON.stringify(event.dims, { strict: true }),
                    context
                );
            }

            if (cursor) {
                this.writeCursor.run(cursor.path, cursor.offset, cursor.lines, Date.now());
            }
        });

        try {
            run();
        } catch (error) {
            // A rolled-back transaction may have created a metric whose id the cache now holds.
            this.ids.clear();
            throw error;
        }

        return events.length;
    }

    query(query: MetricQuery): MetricQueryResult {
        const started = performance.now();
        const id = this.findMetricId(query.project, query.metric);
        const base = {
            project: query.project,
            metric: query.metric,
            groupBy: [...new Set(query.groupBy ?? [])],
            aggregates: query.aggregates?.length ? [...new Set(query.aggregates)] : (["count", "sum"] as const),
        };

        // Built even for an unknown metric, so a bad dim name or sort key is refused the same way.
        const built = buildAggregateSql(id ?? 1, query, this.aggregateOptions(id));

        if (id === undefined) {
            return {
                ...base,
                aggregates: [...base.aggregates],
                rows: [],
                known: false,
                ms: performance.now() - started,
            };
        }

        const raw = this.db.query<Record<string, unknown>, typeof built.params>(built.sql).all(...built.params);
        const rows: MetricQueryRow[] = raw.map((row) => ({
            group: Object.fromEntries(built.groups.map((group) => [group.name, groupValue(row[group.alias])])),
            values: Object.fromEntries(
                built.aggregates.map((aggregate) => [aggregate.name, numberOrNull(row[aggregate.alias])])
            ),
        }));
        return { ...base, aggregates: [...base.aggregates], rows, known: true, ms: performance.now() - started };
    }

    /** The percentile mode and the metric's declared dims, whose indexes a query may name. */
    private aggregateOptions(id: number | undefined): AggregateOptions {
        const row =
            id === undefined
                ? null
                : this.db.query<{ dims_json: string }, [number]>("SELECT dims_json FROM metrics WHERE id = ?").get(id);
        return { percentiles: this.percentiles, declared: declaredDims(row?.dims_json ?? "[]") };
    }

    /** SQLite's plan for a query (`EXPLAIN QUERY PLAN`), one line per step: which index it reads. */
    plan(query: MetricQuery): string[] {
        const id = this.findMetricId(query.project, query.metric);

        if (id === undefined) {
            return [];
        }

        const built = buildAggregateSql(id, query, this.aggregateOptions(id));
        return this.db
            .query<{ detail: string }, typeof built.params>(`EXPLAIN QUERY PLAN ${built.sql}`)
            .all(...built.params)
            .map((row) => row.detail);
    }

    events(query: MetricEventsQuery): MetricEventsResult {
        const id = this.findMetricId(query.project, query.metric);
        const built = buildEventsSql(id ?? 1, query);

        if (id === undefined) {
            return { project: query.project, metric: query.metric, known: false, rows: [] };
        }

        const rows = this.db
            .query<
                { id: number; at: number; value: number; dims: string; context: string | null },
                typeof built.params
            >(built.sql)
            .all(...built.params)
            .map(
                (row): MetricEventRow => ({
                    id: row.id,
                    at: row.at,
                    value: row.value,
                    dims: dimsOf(row.dims),
                    ...(row.context === null ? {} : { context: SafeJSON.parse(row.context, { strict: true }) }),
                })
            );
        return { project: query.project, metric: query.metric, known: true, rows };
    }

    /** Every project and metric, with its event count and its first and last event time. */
    catalog(): MetricCatalogEntry[] {
        const counts = new Map(
            this.db
                .query<{ metric_id: number; count: number; first: number | null; last: number | null }, []>(
                    "SELECT metric_id, COUNT(*) AS count, MIN(at) AS first, MAX(at) AS last FROM events GROUP BY metric_id"
                )
                .all()
                .map((row) => [row.metric_id, row])
        );
        return this.db
            .query<MetricRow, []>(
                "SELECT metrics.id AS id, projects.name AS project, metrics.name AS name, metrics.unit AS unit, metrics.description AS description, metrics.dims_json AS dims_json FROM metrics JOIN projects ON projects.id = metrics.project_id ORDER BY projects.name, metrics.name"
            )
            .all()
            .map((row) => {
                const count = counts.get(row.id);
                return {
                    project: row.project,
                    metric: row.name,
                    ...(row.unit ? { unit: row.unit } : {}),
                    ...(row.description ? { description: row.description } : {}),
                    dims: declaredDims(row.dims_json),
                    count: count?.count ?? 0,
                    ...(count?.first != null ? { first: count.first } : {}),
                    ...(count?.last != null ? { last: count.last } : {}),
                };
            });
    }

    spoolFile(path: string): SpoolFileState | undefined {
        const row = this.db
            .query<{ path: string; offset: number; lines: number; updated_at: number }, [string]>(
                "SELECT path, offset, lines, updated_at FROM spool_files WHERE path = ?"
            )
            .get(path);
        return row ? { path: row.path, offset: row.offset, lines: row.lines, updatedAt: row.updated_at } : undefined;
    }

    spoolFiles(): SpoolFileState[] {
        return this.db
            .query<{ path: string; offset: number; lines: number; updated_at: number }, []>(
                "SELECT path, offset, lines, updated_at FROM spool_files ORDER BY path"
            )
            .all()
            .map((row) => ({ path: row.path, offset: row.offset, lines: row.lines, updatedAt: row.updated_at }));
    }

    /** Forgets a spool file that was read to its end and deleted. */
    forgetSpoolFile(path: string): void {
        this.db.run("DELETE FROM spool_files WHERE path = ?", [path]);
    }

    /** Deletes the events before `before` (epoch ms); answers how many went. */
    prune(before: number): number {
        const removed = this.db.run("DELETE FROM events WHERE at < ?", [Math.floor(before)]).changes;
        log.debug({ before, removed }, "metrics events pruned");
        return removed;
    }

    /** The number of events in the store, for `status`. */
    eventCount(): number {
        return this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0;
    }
}

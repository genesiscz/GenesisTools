import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { applyPragmas } from "@genesiscz/utils/database/pragmas";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    type CheckpointMark,
    checkpointAt,
    checkpointSpan,
    checkpointWindows,
    resolveCheckpointBounds,
} from "./checkpoints";
import { assertDimName, assertMetricsName, checkCheckpoint, isDimName, MetricsInputError } from "./dims";
import { METRICS_MIGRATION_SCOPE, METRICS_MIGRATIONS } from "./migrations";
import {
    type AggregateOptions,
    buildAggregateSql,
    buildEventsSql,
    buildFirstAtSql,
    dimIndexSql,
    namesCheckpoint,
    type PercentileMode,
} from "./sql";
import {
    CHECKPOINT_GROUP,
    type Dims,
    type MetricCatalogEntry,
    type MetricCheckpoint,
    type MetricCheckpointInput,
    type MetricDefinition,
    type MetricEventRow,
    type MetricEventsQuery,
    type MetricEventsResult,
    type MetricQuery,
    type MetricQueryResult,
    type MetricQueryRow,
    RATE_AGGREGATES,
    type SpoolFileState,
    type StoredEvent,
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

interface CheckpointRow {
    project: string;
    name: string;
    at: number;
    commit_sha: string | null;
    repo: string | null;
    note: string | null;
    data: string | null;
}

function checkpointOf(row: CheckpointRow): MetricCheckpoint {
    return {
        project: row.project,
        name: row.name,
        at: row.at,
        ...(row.commit_sha === null ? {} : { commit: row.commit_sha }),
        ...(row.repo === null ? {} : { repo: row.repo }),
        ...(row.note === null ? {} : { note: row.note }),
        ...(row.data === null ? {} : { data: SafeJSON.parse(row.data, { strict: true }) }),
    };
}

const CHECKPOINT_COLUMNS =
    "projects.name AS project, checkpoints.name AS name, checkpoints.at AS at, checkpoints.commit_sha AS commit_sha, checkpoints.repo AS repo, checkpoints.note AS note, checkpoints.data AS data";

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
        percentiles: PercentileMode | undefined,
        /** False for a read-only store whose file predates the checkpoints migration. */
        private readonly hasCheckpoints = true
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
        const tables = new Set(
            db
                .query<{ name: string }, []>(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'metrics', 'projects', 'spool_files', 'checkpoints')"
                )
                .all()
                .map((row) => row.name)
        );

        if (!["events", "metrics", "projects", "spool_files"].every((name) => tables.has(name))) {
            db.close();
            return undefined;
        }

        log.debug({ path, checkpoints: tables.has("checkpoints") }, "metrics store opened read-only");
        return new MetricsStore(db, path, undefined, tables.has("checkpoints"));
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
        const projectId = this.ensureProjectId(project, now);
        const inserted = this.db
            .query<{ id: number }, [number, string, number]>(
                "INSERT INTO metrics (project_id, name, created_at) VALUES (?, ?, ?) RETURNING id"
            )
            .get(projectId, metric, now);

        if (!inserted) {
            throw new Error(`metric ${project}/${metric} was not created`);
        }

        log.debug({ project, metric, id: inserted.id }, "metric created");
        this.ids.set(key, inserted.id);
        return inserted.id;
    }

    /** The project's id, creating the project when it is new. */
    private ensureProjectId(project: string, now: number): number {
        this.db.run("INSERT INTO projects (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING", [
            project,
            now,
        ]);
        const row = this.db.query<{ id: number }, [string]>("SELECT id FROM projects WHERE name = ?").get(project);

        if (!row) {
            throw new Error(`metrics project ${project} was not created`);
        }

        return row.id;
    }

    /**
     * Adds a checkpoint, or updates the one of that name: a field given replaces the stored one, a field left out keeps
     * it. `at` is now for a new checkpoint without one, and stays for an existing one.
     */
    addCheckpoint(input: MetricCheckpointInput, now = Date.now()): MetricCheckpoint {
        const check = checkCheckpoint(input, now);

        if (!check.ok) {
            throw new MetricsInputError(`checkpoint: ${check.reason}`);
        }

        const { checkpoint } = check;
        this.db.transaction(() => {
            const projectId = this.ensureProjectId(checkpoint.project, now);
            this.db.run(
                "INSERT INTO checkpoints (project_id, name, at, commit_sha, repo, note, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET at = COALESCE(?, checkpoints.at), commit_sha = COALESCE(excluded.commit_sha, checkpoints.commit_sha), repo = COALESCE(excluded.repo, checkpoints.repo), note = COALESCE(excluded.note, checkpoints.note), data = COALESCE(excluded.data, checkpoints.data), updated_at = excluded.updated_at",
                [
                    projectId,
                    checkpoint.name,
                    checkpoint.at ?? now,
                    checkpoint.commit ?? null,
                    checkpoint.repo ?? null,
                    checkpoint.note ?? null,
                    check.dataJson ?? null,
                    now,
                    now,
                    checkpoint.at ?? null,
                ]
            );
        })();

        const stored = this.checkpoints(checkpoint.project).find((each) => each.name === checkpoint.name);

        if (!stored) {
            throw new Error(`checkpoint ${checkpoint.project}/${checkpoint.name} is missing after add`);
        }

        log.debug({ project: stored.project, name: stored.name, at: stored.at }, "metrics checkpoint added");
        return stored;
    }

    /** The checkpoints of one project, or of every project, by project and time. */
    checkpoints(project?: string): MetricCheckpoint[] {
        if (!this.hasCheckpoints) {
            return [];
        }

        const from = `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints JOIN projects ON projects.id = checkpoints.project_id`;
        const order = "ORDER BY projects.name, checkpoints.at, checkpoints.id";

        if (project === undefined) {
            return this.db.query<CheckpointRow, []>(`${from} ${order}`).all().map(checkpointOf);
        }

        return this.db
            .query<CheckpointRow, [string]>(`${from} WHERE projects.name = ? ${order}`)
            .all(project)
            .map(checkpointOf);
    }

    /** Removes a checkpoint; answers whether one was there. */
    removeCheckpoint(project: string, name: string): boolean {
        const removed = this.db.run(
            "DELETE FROM checkpoints WHERE name = ? AND project_id = (SELECT id FROM projects WHERE name = ?)",
            [name, project]
        ).changes;
        log.debug({ project, name, removed }, "metrics checkpoint removed");
        return removed > 0;
    }

    /** The checkpoints a query reads, sorted by time; none when it does not name the checkpoint. */
    private marksFor(filter: Parameters<typeof namesCheckpoint>[0]): CheckpointMark[] {
        return namesCheckpoint(filter)
            ? this.checkpoints(filter.project).map((checkpoint) => ({ name: checkpoint.name, at: checkpoint.at }))
            : [];
    }

    /** Declares a metric: its unit, description and the dims that get an index. A later call adds dims. */
    define(definition: MetricDefinition): MetricCatalogEntry {
        const project = assertMetricsName("project", definition.project);
        const metric = assertMetricsName("metric", definition.metric);
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

    query(asked: MetricQuery): MetricQueryResult {
        const started = performance.now();
        const marks = this.marksFor(asked);
        const query = resolveCheckpointBounds(asked, marks);
        const id = this.findMetricId(query.project, query.metric);
        const base = {
            project: query.project,
            metric: query.metric,
            groupBy: [...new Set(query.groupBy ?? [])],
            aggregates: query.aggregates?.length ? [...new Set(query.aggregates)] : (["count", "sum"] as const),
        };

        // Built even for an unknown metric, so a bad dim name or sort key is refused the same way.
        const built = buildAggregateSql(id ?? 1, query, { ...this.aggregateOptions(id), checkpoints: marks });

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
        const spanned =
            base.groupBy.length === 1 && base.groupBy[0] === CHECKPOINT_GROUP
                ? this.withSpans(rows, { id, query, marks })
                : rows;
        return {
            ...base,
            aggregates: [...base.aggregates],
            rows: spanned,
            known: true,
            ms: performance.now() - started,
        };
    }

    /**
     * Each checkpoint group's span and its count and sum per day: the spans differ in length, so a raw sum misleads.
     * An open start is the query's `since`, else the window's first event.
     */
    private withSpans(
        rows: readonly MetricQueryRow[],
        context: { id: number; query: Pick<MetricQuery, "since" | "until">; marks: readonly CheckpointMark[] }
    ): MetricQueryRow[] {
        const windows = checkpointWindows(context.marks);
        const firstSql = buildFirstAtSql(context.id, context.query);
        const first = this.db
            .query<{ first: number | null }, typeof firstSql.params>(firstSql.sql)
            .get(...firstSql.params)?.first;
        const bounds = {
            since: context.query.since,
            until: context.query.until,
            firstAt: first ?? undefined,
            now: Date.now(),
        };

        return rows.map((row) => {
            const label = row.group[CHECKPOINT_GROUP];
            const window = typeof label === "string" ? windows.get(label) : undefined;

            if (!window) {
                return row;
            }

            const span = checkpointSpan(window, bounds);
            const perDay = Object.fromEntries(
                RATE_AGGREGATES.filter((name) => row.values[name] !== undefined).map((name) => {
                    const value = row.values[name];
                    return [name, span.days > 0 && typeof value === "number" ? value / span.days : null];
                })
            );
            return { ...row, span, perDay };
        });
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

    events(asked: MetricEventsQuery): MetricEventsResult {
        const marks = this.marksFor(asked);
        const query = resolveCheckpointBounds(asked, marks);
        const id = this.findMetricId(query.project, query.metric);
        const built = buildEventsSql(id ?? 1, query, marks);

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
                    ...(query.withCheckpoint ? { checkpoint: checkpointAt(marks, row.at) } : {}),
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

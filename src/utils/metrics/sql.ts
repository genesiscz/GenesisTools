import type { SQLQueryBindings } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import { assertDimName, MetricsInputError } from "./dims";
import {
    METRIC_AGGREGATES,
    type MetricAggregate,
    type MetricEventsQuery,
    type MetricFilter,
    type MetricQuery,
    type MetricWhere,
    TIME_GROUPS,
    type TimeGroup,
} from "./types";

/**
 * Every SQL text built from a request lives here. A dim name enters SQL only after `assertDimName`, a metric id only
 * as a safe integer, and every value as a bound parameter. The metric id is written into the text, not bound, so the
 * planner can use a declared dim's partial index (`WHERE metric_id = <id>`).
 */

export const DEFAULT_QUERY_LIMIT = 50;
export const DEFAULT_EVENTS_LIMIT = 20;
export const MAX_LIMIT = 10_000;

/** How percentiles are computed: SQLite's `percentile()` where it is built in, else a window function. */
export type PercentileMode = "native" | "window";

export interface BuiltSql {
    sql: string;
    params: SQLQueryBindings[];
}

export interface AggregateSql extends BuiltSql {
    groups: Array<{ name: string; alias: string }>;
    aggregates: Array<{ name: MetricAggregate; alias: string }>;
}

function metricIdText(metricId: number): string {
    if (!Number.isSafeInteger(metricId) || metricId < 1) {
        throw new Error(`metric id ${metricId} is not a positive integer`);
    }

    return String(metricId);
}

/** The expression a dim is read by: the same text in a query and in its index, so the planner matches them. */
export function dimExpr(dim: string): string {
    return `json_extract(dims, '$.${assertDimName(dim)}')`;
}

/** The index name of a declared dim: the dim in hex, since SQLite index names ignore case and dim names do not. */
function dimIndexName(metricId: number, dim: string): string {
    return `events_m${metricIdText(metricId)}_d${Buffer.from(assertDimName(dim)).toString("hex")}`;
}

/**
 * The partial expression index of one declared dim of one metric. It carries `at` and `value`, so a group by the dim
 * (with a time window) reads the index alone: at 1 M events 49 ms against 835 ms for the dim alone (benchmark,
 * `scripts/benchmarks/metrics/`), where every row's dims JSON was parsed again.
 */
export function dimIndexSql(metricId: number, dim: string): string {
    return `CREATE INDEX IF NOT EXISTS ${dimIndexName(metricId, dim)} ON events(${dimExpr(dim)}, at, value) WHERE metric_id = ${metricIdText(metricId)}`;
}

/**
 * The index a query must read: a declared dim's index when the query groups by that dim and touches no other dim,
 * so it reads only index columns. SQLite's planner without statistics picks the `(metric_id, at)` index there and
 * parses each row's JSON (731 ms against 49 ms at 1 M events).
 */
function indexHint(metricId: number, query: MetricQuery, declared: readonly string[]): string {
    const first = query.groupBy?.find((name) => !isTimeGroup(name));
    const touched = new Set([
        ...(query.groupBy ?? []).filter((name) => !isTimeGroup(name)),
        ...(query.where ?? []).map((where) => where.dim),
    ]);

    if (!first || touched.size !== 1 || !declared.includes(first)) {
        return "";
    }

    return ` INDEXED BY ${dimIndexName(metricId, first)}`;
}

function isTimeGroup(name: string): name is TimeGroup {
    return Object.hasOwn(TIME_GROUPS, name);
}

function groupExpr(name: string): string {
    if (isTimeGroup(name)) {
        const size = TIME_GROUPS[name];
        return `((at / ${size}) * ${size})`;
    }

    return dimExpr(name);
}

function bindable(value: unknown, dim: string): SQLQueryBindings {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
        return value;
    }

    throw new MetricsInputError(`where ${dim}: ${SafeJSON.stringify(value)} is not a string, number or boolean`);
}

function whereClause(where: MetricWhere, params: SQLQueryBindings[]): string {
    const expr = dimExpr(where.dim);
    const { value } = where;

    switch (where.op) {
        case "=":
        case "!=": {
            if (Array.isArray(value)) {
                throw new MetricsInputError(`where ${where.dim} ${where.op}: one value, or use "in" for a list`);
            }

            if (value === null) {
                return `${expr} ${where.op === "=" ? "IS NULL" : "IS NOT NULL"}`;
            }

            params.push(bindable(value, where.dim));
            return where.op === "=" ? `${expr} = ?` : `${expr} IS NOT ?`;
        }
        case "in": {
            const list = Array.isArray(value) ? value : [value];

            if (list.length === 0) {
                throw new MetricsInputError(`where ${where.dim} in: an empty list matches nothing`);
            }

            params.push(...list.map((each) => bindable(each, where.dim)));
            return `${expr} IN (${list.map(() => "?").join(", ")})`;
        }
        case "glob": {
            if (typeof value !== "string") {
                throw new MetricsInputError(`where ${where.dim} glob: the pattern is a string`);
            }

            params.push(value);
            return `${expr} GLOB ?`;
        }
        default: {
            const never: never = where.op;
            throw new MetricsInputError(`unknown where operator ${String(never)}`);
        }
    }
}

function filterSql(metricId: number, filter: MetricFilter, params: SQLQueryBindings[]): string {
    const clauses = [`metric_id = ${metricIdText(metricId)}`];

    if (filter.since !== undefined) {
        clauses.push("at >= ?");
        params.push(Math.floor(filter.since));
    }

    if (filter.until !== undefined) {
        clauses.push("at < ?");
        params.push(Math.floor(filter.until));
    }

    for (const where of filter.where ?? []) {
        clauses.push(whereClause(where, params));
    }

    return clauses.join(" AND ");
}

function limitOf(limit: number | undefined, fallback: number): number {
    if (limit === undefined) {
        return fallback;
    }

    if (!Number.isInteger(limit) || limit < 1) {
        throw new MetricsInputError(`limit ${limit} is not a positive whole number`);
    }

    return Math.min(limit, MAX_LIMIT);
}

function percentOf(aggregate: MetricAggregate): number | undefined {
    return aggregate.startsWith("p") ? Number(aggregate.slice(1)) : undefined;
}

function simpleAggregate(aggregate: MetricAggregate): string {
    switch (aggregate) {
        case "count":
            return "COUNT(*)";
        case "sum":
            return "SUM(value)";
        case "avg":
            return "AVG(value)";
        case "min":
            return "MIN(value)";
        case "max":
            return "MAX(value)";
        default:
            return `percentile(value, ${percentOf(aggregate)})`;
    }
}

/**
 * A continuous percentile over the ranked rows of `ranked` (rank `r` from 0, group size `n`), as SQLite's own
 * `percentile()` computes it: the value at position (n - 1) * p, interpolated between its two neighbours.
 */
function windowPercentile(percent: number): string {
    const position = `(((n - 1) * ${percent}) / 100.0)`;
    const low = `CAST(${position} AS INTEGER)`;
    const fraction = `(${position} - ${low})`;
    return `SUM(CASE WHEN r = ${low} THEN value * (1 - ${fraction}) WHEN r = ${low} + 1 THEN value * ${fraction} ELSE 0 END)`;
}

function sortSql(query: MetricQuery, built: Pick<AggregateSql, "groups" | "aggregates">): string {
    const aliases = new Map<string, string>([
        ...built.groups.map((group) => [group.name, group.alias] as const),
        ...built.aggregates.map((aggregate) => [aggregate.name, aggregate.alias] as const),
    ]);

    if (query.sort) {
        const alias = aliases.get(query.sort.by);

        if (!alias) {
            throw new MetricsInputError(
                `sort by ${SafeJSON.stringify(query.sort.by)}: not a group key or an aggregate of this query (${[...aliases.keys()].join(", ")})`
            );
        }

        return `${alias} ${query.sort.descending ? "DESC" : "ASC"}`;
    }

    const fallback = built.aggregates.find((aggregate) => aggregate.name === "sum") ?? built.aggregates[0];
    return `${fallback?.alias ?? "a_count"} DESC`;
}

/** How the store answers: its percentile function, and the metric's declared (indexed) dims. */
export interface AggregateOptions {
    percentiles: PercentileMode;
    declared: readonly string[];
}

/** The SQL of one `query`: filter, group by dims and time buckets, aggregates, sort and limit. */
export function buildAggregateSql(metricId: number, query: MetricQuery, options: AggregateOptions): AggregateSql {
    const { percentiles } = options;
    const params: SQLQueryBindings[] = [];
    const groupNames = [...new Set(query.groupBy ?? [])];
    const groups = groupNames.map((name, index) => ({ name, alias: `g${index}`, expr: groupExpr(name) }));
    const aggregateNames = [...new Set(query.aggregates?.length ? query.aggregates : (["count", "sum"] as const))];

    for (const name of aggregateNames) {
        if (!METRIC_AGGREGATES.includes(name)) {
            throw new MetricsInputError(`unknown aggregate ${SafeJSON.stringify(name)}`);
        }
    }

    const aggregates = aggregateNames.map((name) => ({ name, alias: `a_${name}` }));
    const where = filterSql(metricId, query, params);
    const order = sortSql(query, { groups, aggregates });
    const limit = limitOf(query.limit, DEFAULT_QUERY_LIMIT);
    const groupList = groups.map((group) => group.alias).join(", ");
    const needsWindow = percentiles === "window" && aggregates.some((aggregate) => percentOf(aggregate.name));
    const from = `events${indexHint(metricId, query, options.declared)}`;
    let sql: string;

    if (!needsWindow) {
        const select = [
            ...groups.map((group) => `${group.expr} AS ${group.alias}`),
            ...aggregates.map((aggregate) => `${simpleAggregate(aggregate.name)} AS ${aggregate.alias}`),
        ].join(", ");
        const groupBy = groups.length ? ` GROUP BY ${groups.map((group) => group.expr).join(", ")}` : "";
        sql = `SELECT ${select} FROM ${from} WHERE ${where}${groupBy} ORDER BY ${order} LIMIT ?`;
    } else {
        const base = [...groups.map((group) => `${group.expr} AS ${group.alias}`), "value"].join(", ");
        const partition = groups.length ? `PARTITION BY ${groupList} ` : "";
        const select = [
            ...groups.map((group) => group.alias),
            ...aggregates.map((aggregate) => {
                const percent = percentOf(aggregate.name);
                return `${percent === undefined ? simpleAggregate(aggregate.name) : windowPercentile(percent)} AS ${aggregate.alias}`;
            }),
        ].join(", ");
        const groupBy = groups.length ? ` GROUP BY ${groupList}` : "";
        sql =
            `WITH base AS (SELECT ${base} FROM ${from} WHERE ${where}), ` +
            `ranked AS (SELECT *, ROW_NUMBER() OVER (${partition}ORDER BY value) - 1 AS r, COUNT(*) OVER (${partition.trim()}) AS n FROM base) ` +
            `SELECT ${select} FROM ranked${groupBy} ORDER BY ${order} LIMIT ?`;
    }

    params.push(limit);
    return {
        sql,
        params,
        groups: groups.map(({ name, alias }) => ({ name, alias })),
        aggregates,
    };
}

/** The SQL of one `events` call: the single events with their context, newest first. */
export function buildEventsSql(metricId: number, query: MetricEventsQuery): BuiltSql {
    const params: SQLQueryBindings[] = [];
    const where = filterSql(metricId, query, params);
    params.push(limitOf(query.limit, DEFAULT_EVENTS_LIMIT));
    return {
        sql: `SELECT id, at, value, dims, context FROM events WHERE ${where} ORDER BY at DESC, id DESC LIMIT ?`,
        params,
    };
}

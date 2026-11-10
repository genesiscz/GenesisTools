import { parseSince } from "@genesiscz/utils/date";
import { parseDuration } from "@genesiscz/utils/format";
import {
    type DimValue,
    METRIC_AGGREGATES,
    type MetricAggregate,
    type MetricCaller,
    type MetricFilter,
    type MetricQuery,
    type MetricWhere,
} from "@genesiscz/utils/metrics/types";

/** The flags `query` and `events` share. */
export interface FilterFlags {
    since?: string;
    until?: string;
    where?: string[];
    limit?: string;
    json?: boolean;
}

export interface QueryFlags extends FilterFlags {
    groupBy?: string;
    agg?: string | true;
    sort?: string;
}

export class FlagError extends Error {}

/** `10d`, `2h`, `30m`: that long before now; else a date, a time or `HH:MM` as `--since` reads it elsewhere. */
export function parseWhen(text: string, flag: string, now = Date.now()): number {
    const trimmed = text.trim();

    if (/^\d+\s*[smhd]/i.test(trimmed)) {
        const ms = parseDuration(trimmed);

        if (ms > 0) {
            return now - ms;
        }
    }

    const at = parseSince(trimmed, new Date(now));

    if (!at) {
        throw new FlagError(`${flag} ${trimmed}: not a span (10d, 2h, 30m), a date (2026-11-01) or a time (09:30)`);
    }

    return at.getTime();
}

/** A `--where` value as the dims hold it: `null`, `true`, `false`, a number, else the text. */
export function dimValueOf(text: string): DimValue {
    if (text === "null") {
        return null;
    }

    if (text === "true" || text === "false") {
        return text === "true";
    }

    if (/^-?\d+(\.\d+)?$/.test(text)) {
        return Number(text);
    }

    return text;
}

/** `k=v`, `k=a,b` (one of), `k!=v`, `k~glob`. */
export function parseWhere(text: string): MetricWhere {
    const match = /^([^=!~]+)(!=|=|~)(.*)$/.exec(text);

    if (!match) {
        throw new FlagError(`--where ${text}: write dim=value, dim=a,b, dim!=value or dim~glob`);
    }

    const dim = (match[1] ?? "").trim();
    const op = match[2];
    const raw = match[3] ?? "";

    if (op === "~") {
        return { dim, op: "glob", value: raw };
    }

    if (op === "=" && raw.includes(",")) {
        return {
            dim,
            op: "in",
            value: raw.split(",").map((each) => {
                const value = dimValueOf(each);
                return typeof value === "number" ? value : String(value);
            }),
        };
    }

    return { dim, op: op === "!=" ? "!=" : "=", value: dimValueOf(raw) };
}

function limitOf(text: string | undefined): number | undefined {
    if (text === undefined) {
        return undefined;
    }

    const limit = Number(text);

    if (!Number.isInteger(limit) || limit < 1) {
        throw new FlagError(`--limit ${text}: a whole number from 1`);
    }

    return limit;
}

export function callerOf(reason: string): MetricCaller {
    return { tool: "metrics-cli", pid: process.pid, reason };
}

export function filterOf(project: string, metric: string, flags: FilterFlags, reason: string): MetricFilter {
    return {
        project,
        metric,
        ...(flags.since ? { since: parseWhen(flags.since, "--since") } : {}),
        ...(flags.until ? { until: parseWhen(flags.until, "--until") } : {}),
        ...(flags.where?.length ? { where: flags.where.map(parseWhere) } : {}),
        caller: callerOf(reason),
    };
}

function isAggregate(name: string): name is MetricAggregate {
    return METRIC_AGGREGATES.some((aggregate) => aggregate === name);
}

/** The aggregates of `--agg sum,count,p90`; undefined for the default (count and sum). */
export function aggregatesOf(flag: string | undefined): MetricAggregate[] | undefined {
    if (!flag) {
        return undefined;
    }

    const names = flag
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    const unknown = names.filter((name) => !isAggregate(name));

    if (unknown.length > 0) {
        throw new FlagError(`--agg ${unknown.join(",")}: not one of ${METRIC_AGGREGATES.join(", ")}`);
    }

    return names.filter(isAggregate);
}

export function queryOf(project: string, metric: string, flags: QueryFlags): MetricQuery {
    const groupBy = flags.groupBy
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    const aggregates = aggregatesOf(typeof flags.agg === "string" ? flags.agg : undefined);
    const sort = flags.sort?.trim();
    const limit = limitOf(flags.limit);

    return {
        ...filterOf(project, metric, flags, "query"),
        ...(groupBy?.length ? { groupBy } : {}),
        ...(aggregates ? { aggregates } : {}),
        ...(sort ? { sort: { by: sort.replace(/^[-+]/, ""), descending: sort.startsWith("-") } } : {}),
        ...(limit ? { limit } : {}),
    };
}

export function eventsLimitOf(flags: FilterFlags): number | undefined {
    return limitOf(flags.limit);
}

/** Collects a repeatable flag. */
export function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

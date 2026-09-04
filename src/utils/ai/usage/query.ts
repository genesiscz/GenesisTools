import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { dayFilePath, daysInRange, parseBound } from "./paths";
import { isValidTimeZone, spendBucketKey } from "./series-keys";
import type {
    SpendSeriesBucket,
    SpendSeriesPoint,
    UsageAggregate,
    UsageEvent,
    UsageQuery,
    UsageQueryResult,
} from "./types";

/**
 * Read usage rows over a window and fold them.
 *
 * Reads only the day-files the window touches, so a "last 24h" query never
 * parses last year. A malformed line is skipped and logged rather than failing
 * the query: the corpus is append-only JSONL written by several processes, and
 * one truncated tail must not hide every other row.
 */
export function queryUsage(query: UsageQuery): UsageQueryResult {
    // Up here rather than in `bucketPoints`: there the throw would come from
    // `Intl.DateTimeFormat` on the first event, so a query over an empty window
    // would accept the same zone a populated one rejects.
    if (query.timeZone !== undefined && !isValidTimeZone(query.timeZone)) {
        throw new Error(
            `queryUsage: unknown timeZone "${query.timeZone}". Pass an IANA identifier such as "Europe/Prague", or omit it for the system zone.`
        );
    }

    const from = parseBound(query.from);
    const to = parseBound(query.to);
    const apps = toSet(query.app);
    const accounts = toSet(query.accountId);
    const events: UsageEvent[] = [];

    for (const day of daysInRange(from, to)) {
        for (const event of readDay(day)) {
            const at = new Date(event.at);

            if (at < from || at >= to) {
                continue;
            }

            if (apps && !apps.has(event.app)) {
                continue;
            }

            if (accounts && !accounts.has(event.accountId)) {
                continue;
            }

            events.push(event);
        }
    }

    events.sort((a, b) => a.at.localeCompare(b.at));

    const result: UsageQueryResult = {
        total: fold(events),
        byApp: groupBy(events, (event) => event.app),
        byAccount: groupBy(events, (event) => event.accountId),
        byModel: groupBy(events, (event) => `${event.provider}/${event.modelId}`),
        events,
    };

    if (query.grain) {
        result.points = bucketPoints(events, query);
    }

    return result;
}

function addTo(into: Record<string, SpendSeriesBucket>, key: string, event: UsageEvent): void {
    const bucket = into[key] ?? { costUsd: 0, tokens: 0 };
    bucket.costUsd += event.costUsd ?? 0;
    bucket.tokens += event.inputTokens + event.outputTokens;
    into[key] = bucket;
}

/**
 * Fold the same rows into time buckets.
 *
 * `tokens` is input + output, the only two counts a `UsageEvent` carries. An
 * event with no `costUsd` adds nothing to `costUsd` here and is already counted
 * in `total.unpricedEvents`, so a point that looks cheap can be checked against
 * that number rather than being taken at face value.
 */
function bucketPoints(events: UsageEvent[], query: UsageQuery): SpendSeriesPoint[] {
    const grain = query.grain;

    if (!grain) {
        return [];
    }

    const buckets = new Map<string, SpendSeriesPoint>();

    for (const event of events) {
        const key = spendBucketKey(event.at, grain, query.timeZone);

        if (key === "") {
            logger.debug({ at: event.at }, "usage: row has an unusable timestamp; not bucketed");
            continue;
        }

        let point = buckets.get(key);

        if (!point) {
            point = { t: key, costUsd: 0, tokens: 0, byAccount: emptyBuckets<SpendSeriesBucket>() };

            if (query.byModel) {
                point.byModel = emptyBuckets<SpendSeriesBucket>();
            }

            buckets.set(key, point);
        }

        point.costUsd += event.costUsd ?? 0;
        point.tokens += event.inputTokens + event.outputTokens;
        addTo(point.byAccount, event.accountId, event);

        if (point.byModel) {
            addTo(point.byModel, `${event.provider}/${event.modelId}`, event);
        }
    }

    return [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
}

function toSet(value: string | string[] | undefined): Set<string> | undefined {
    if (value === undefined) {
        return undefined;
    }

    return new Set(Array.isArray(value) ? value : [value]);
}

function readDay(day: string): UsageEvent[] {
    const path = dayFilePath(day);

    if (!existsSync(path)) {
        return [];
    }

    let raw: string;

    try {
        raw = readFileSync(path, "utf8");
    } catch (err) {
        logger.warn({ err, path }, "usage: day file unreadable; skipping it");
        return [];
    }

    const events: UsageEvent[] = [];

    for (const line of raw.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(line, { jsonl: true }) as UsageEvent;

            if (isUsageEvent(parsed)) {
                events.push(parsed);
            } else {
                logger.debug({ path }, "usage: row missing required fields; skipped");
            }
        } catch (err) {
            logger.debug({ err, path }, "usage: unparseable row; skipped");
        }
    }

    return events;
}

function isUsageEvent(value: unknown): value is UsageEvent {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Partial<UsageEvent>;

    return (
        typeof candidate.at === "string" &&
        typeof candidate.app === "string" &&
        typeof candidate.accountId === "string" &&
        typeof candidate.provider === "string" &&
        typeof candidate.modelId === "string" &&
        typeof candidate.inputTokens === "number" &&
        typeof candidate.outputTokens === "number"
    );
}

/**
 * A prototype-free map for buckets keyed by DATA rather than by code.
 *
 * Account ids, app names and model ids are opaque strings read back out of the
 * corpus. On a plain object a key of `"__proto__"` resolves to
 * `Object.prototype` instead of an own slot, so the running total accumulates
 * onto the shared prototype and that row then disappears from the result. With
 * no prototype there is nothing to inherit and every key is an ordinary one.
 */
export function emptyBuckets<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

export function emptyAggregate(): UsageAggregate {
    return { events: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedEvents: 0 };
}

function fold(events: UsageEvent[], into: UsageAggregate = emptyAggregate()): UsageAggregate {
    for (const event of events) {
        into.events += 1;
        into.inputTokens += event.inputTokens;
        into.outputTokens += event.outputTokens;

        if (typeof event.costUsd === "number") {
            into.costUsd += event.costUsd;
        } else {
            into.unpricedEvents += 1;
        }
    }

    return into;
}

function groupBy(events: UsageEvent[], key: (event: UsageEvent) => string): Record<string, UsageAggregate> {
    const groups = emptyBuckets<UsageAggregate>();

    for (const event of events) {
        const bucket = key(event);
        groups[bucket] = fold([event], groups[bucket] ?? emptyAggregate());
    }

    return groups;
}

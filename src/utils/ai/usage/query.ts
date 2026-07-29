import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { dayFilePath, daysInRange, parseBound } from "./paths";
import type { UsageAggregate, UsageEvent, UsageQuery, UsageQueryResult } from "./types";

/**
 * Read usage rows over a window and fold them.
 *
 * Reads only the day-files the window touches, so a "last 24h" query never
 * parses last year. A malformed line is skipped and logged rather than failing
 * the query: the corpus is append-only JSONL written by several processes, and
 * one truncated tail must not hide every other row.
 */
export function queryUsage(query: UsageQuery): UsageQueryResult {
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

    return {
        total: fold(events),
        byApp: groupBy(events, (event) => event.app),
        byAccount: groupBy(events, (event) => event.accountId),
        byModel: groupBy(events, (event) => `${event.provider}/${event.modelId}`),
        events,
    };
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
    const groups: Record<string, UsageAggregate> = {};

    for (const event of events) {
        const bucket = key(event);
        groups[bucket] = fold([event], groups[bucket] ?? emptyAggregate());
    }

    return groups;
}

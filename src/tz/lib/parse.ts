import { logger } from "@app/logger";
import * as chrono from "chrono-node";
import { epochFromWallClockInZone } from "./convert";
import type { ParseResult } from "./types";
import { resolveZone } from "./zones";

interface ParseInput {
    expr: string;
    nowMs: number;
    localZone: string;
}

interface SplitResult {
    timePart: string;
    sourceZone?: string;
    target?: string;
}

// Split "9:00 Europe/Prague to America/New_York" / "3pm PST in Prague" into the
// time portion, an optional explicit source zone, and an optional target zone.
function splitExpression(expr: string): SplitResult {
    const trimmed = expr.trim();

    const targetMatch = trimmed.match(/\s+(?:in|to)\s+(.+)$/i);
    let head = trimmed;
    let target: string | undefined;
    if (targetMatch && typeof targetMatch.index === "number") {
        target = resolveZone(targetMatch[1]);
        head = trimmed.slice(0, targetMatch.index).trim();
    }

    // A trailing token that resolves to a zone (and is not consumed by chrono as
    // a time) is treated as an explicit source zone, e.g. "... Europe/Prague".
    const tokens = head.split(/\s+/);
    const lastToken = tokens[tokens.length - 1];
    let sourceZone: string | undefined;
    if (tokens.length > 1 && lastToken.includes("/")) {
        try {
            sourceZone = resolveZone(lastToken);
            head = tokens.slice(0, -1).join(" ");
        } catch (err) {
            logger.debug({ err, lastToken }, "tz: trailing token is not a source zone");
            sourceZone = undefined;
        }
    }

    return { timePart: head, sourceZone, target };
}

export function parseExpression({ expr, nowMs, localZone }: ParseInput): ParseResult {
    const { timePart, sourceZone, target } = splitExpression(expr);
    const reference = new Date(nowMs);

    const results = chrono.parse(timePart, reference);
    if (results.length === 0) {
        throw new Error(`Could not parse a time from: "${expr}"`);
    }

    const start = results[0].start;
    const sourceLabel = timePart;

    // Branch (a): chrono is certain about the timezone offset. This covers
    // explicit zones ("3pm PST") AND reference-anchored expressions ("now",
    // "in 2 hours") — chrono marks both tz-certain, so start.date() is the true
    // absolute instant (for "now" it equals nowMs).
    if (start.isCertain("timezoneOffset")) {
        return { epochMs: start.date().getTime(), sourceLabel, target };
    }

    // Branch (b): a date-only input with no certain clock hour — fall back to the
    // reference instant rather than guessing midnight.
    if (!start.isCertain("hour")) {
        return { epochMs: reference.getTime(), sourceLabel, target };
    }

    // Branch (c): a wall-clock time with no certain zone. Read the TYPED
    // components (zone-independent) and interpret them in the source zone if one
    // was given, else the local zone.
    const zone = sourceZone ?? localZone;
    const epochMs = epochFromWallClockInZone(
        start.get("year") ?? reference.getUTCFullYear(),
        start.get("month") ?? 1,
        start.get("day") ?? 1,
        start.get("hour") ?? 0,
        start.get("minute") ?? 0,
        zone
    );
    return { epochMs, sourceLabel, target };
}

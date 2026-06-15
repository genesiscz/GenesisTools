/**
 * General-purpose timezone primitives -- browser-safe (no Node.js imports).
 *
 * Zone resolution (alias/IANA), offset computation, and wall-clock → epoch
 * conversion that correctly handles DST. For locale-aware display formatting,
 * see ./date.ts (which has no timezone helpers).
 */

const ALIAS_MAP: Record<string, string> = {
    pst: "America/Los_Angeles",
    pdt: "America/Los_Angeles",
    mst: "America/Denver",
    mdt: "America/Denver",
    cst: "America/Chicago",
    cdt: "America/Chicago",
    est: "America/New_York",
    edt: "America/New_York",
    gmt: "Etc/GMT",
    bst: "Europe/London",
    cet: "Europe/Prague",
    cest: "Europe/Prague",
    eet: "Europe/Athens",
    utc: "UTC",
    prague: "Europe/Prague",
    london: "Europe/London",
    paris: "Europe/Paris",
    berlin: "Europe/Berlin",
    "new york": "America/New_York",
    newyork: "America/New_York",
    nyc: "America/New_York",
    la: "America/Los_Angeles",
    "los angeles": "America/Los_Angeles",
    tokyo: "Asia/Tokyo",
    sydney: "Australia/Sydney",
};

function isValidIanaZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch (err) {
        if (err instanceof RangeError) {
            return false;
        }

        throw err;
    }
}

/**
 * Resolve a zone token (common abbreviation, city alias, or raw IANA name) to
 * an IANA timezone identifier. Throws if the token is not a known zone.
 */
export function resolveZone(token: string): string {
    const trimmed = token.trim();
    const alias = ALIAS_MAP[trimmed.toLowerCase()];
    if (alias) {
        return alias;
    }

    if (isValidIanaZone(trimmed)) {
        return trimmed;
    }

    throw new Error(`Unknown timezone: "${token}"`);
}

/**
 * Read the calendar parts of an epoch as rendered in a given zone.
 */
export function partsInZone(
    epochMs: number,
    timeZone: string,
    options: Intl.DateTimeFormatOptions
): Record<string, string> {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ...options });
    const parts: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(epochMs))) {
        parts[part.type] = part.value;
    }

    return parts;
}

/**
 * Offset of a zone from UTC, in minutes, at a given instant (DST-aware).
 */
export function zoneOffsetMinutes(epochMs: number, timeZone: string): number {
    const p = partsInZone(epochMs, timeZone, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const asUTC = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second)
    );
    return Math.round((asUTC - epochMs) / 60000);
}

/**
 * Convert a wall-clock time (as it would read on a clock in `timeZone`) to the
 * absolute epoch in milliseconds, resolving the zone's DST offset for that date.
 */
export function epochFromWallClockInZone(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string
): number {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    let offset = zoneOffsetMinutes(guess, timeZone);
    let epoch = guess - offset * 60000;
    offset = zoneOffsetMinutes(epoch, timeZone);
    epoch = guess - offset * 60000;
    return epoch;
}

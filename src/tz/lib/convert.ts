import { parseExpression } from "./parse";
import type { ConvertInput, ConvertResult, ZoneLine } from "./types";
import { resolveZone } from "./zones";

const DEFAULT_ZONES = ["UTC", "America/New_York", "Europe/London", "Europe/Prague", "Asia/Tokyo"];

function partsInZone(epochMs: number, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ...options });
    const parts: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(epochMs))) {
        parts[part.type] = part.value;
    }

    return parts;
}

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

export function renderZone(epochMs: number, zone: string, label: string): ZoneLine {
    const p = partsInZone(epochMs, zone, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
    });
    return {
        zone,
        label,
        weekday: p.weekday,
        date: `${p.month} ${p.day}, ${p.year}`,
        time: `${p.hour}:${p.minute}`,
        offset: p.timeZoneName,
        epochMs,
    };
}

export function convert({ expr, nowMs, localZone, to }: ConvertInput): ConvertResult {
    const parsed = parseExpression({ expr, nowMs, localZone });

    let targets: Array<{ zone: string; label: string }>;
    if (to && to.length > 0) {
        targets = to.map((token) => {
            const zone = resolveZone(token);
            return { zone, label: zone };
        });
    } else if (parsed.target) {
        targets = [{ zone: parsed.target, label: parsed.target }];
    } else {
        targets = [
            { zone: localZone, label: `Local (${localZone})` },
            ...DEFAULT_ZONES.map((zone) => ({ zone, label: zone })),
        ];
    }

    const lines: ZoneLine[] = targets.map(({ zone, label }) => renderZone(parsed.epochMs, zone, label));
    return { sourceLabel: parsed.sourceLabel, lines };
}

export function formatZoneLine(line: ZoneLine): string {
    return `${line.label.padEnd(24)}${line.weekday}, ${line.date}   ${line.time}  (${line.offset})`;
}

import { partsInZone, resolveZone } from "@app/utils/timezone";
import { parseExpression } from "./parse";
import type { ConvertInput, ConvertResult, ZoneLine } from "./types";

const DEFAULT_ZONES = ["UTC", "America/New_York", "Europe/London", "Europe/Prague", "Asia/Tokyo"];

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

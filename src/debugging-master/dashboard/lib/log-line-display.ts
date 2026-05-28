import { stripAnsi } from "@app/utils/string";
import type { TimestampMode } from "./display-settings";
import { formatTime } from "./format";

function pickLogTextRaw(entry: { msg?: string; msgAnsi?: string; label?: string }): string {
    if (entry.msgAnsi !== undefined && entry.msgAnsi !== null) {
        return entry.msgAnsi;
    }

    if (entry.msg?.trim()) {
        return entry.msg;
    }

    return entry.label ?? "";
}

export function visibleLogText(entry: { msg?: string; msgAnsi?: string; label?: string }): string {
    const raw = pickLogTextRaw(entry);

    return stripAnsi(raw).replace(/\r/g, "").trim();
}

export function isBlankLogLine(entry: { msg?: string; msgAnsi?: string; label?: string }): boolean {
    return visibleLogText(entry).length === 0;
}

export function filterDisplayLogLines<T extends { msg?: string; msgAnsi?: string; label?: string }>(lines: T[]): T[] {
    return lines.filter((line) => !isBlankLogLine(line));
}

export function shouldShowLogTimestamp({
    mode,
    ts,
    previousTs,
}: {
    mode: TimestampMode;
    ts: number;
    previousTs?: number;
}): boolean {
    if (mode === "never") {
        return false;
    }

    if (mode === "every") {
        return true;
    }

    if (previousTs === undefined) {
        return true;
    }

    return formatTime(ts) !== formatTime(previousTs);
}

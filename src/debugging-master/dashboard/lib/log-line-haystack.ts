import type { IndexedLogEntry } from "@app/debugging-master/types";
import { visibleLogText } from "@/lib/log-line-display";

export function logLineHaystack(entry: Pick<IndexedLogEntry, "level" | "label" | "msg" | "msgAnsi" | "h" | "file">): string {
    const parts: string[] = [entry.level, visibleLogText(entry)];

    if (entry.label) {
        parts.push(entry.label);
    }

    if (entry.h) {
        parts.push(entry.h);
    }

    if (entry.file) {
        parts.push(entry.file);
    }

    return parts.join(" ");
}

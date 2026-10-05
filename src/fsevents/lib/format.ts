import { formatTable } from "@genesiscz/utils/table";
import type { ChurnProfile } from "./churn";
import { FSEVENTS_DEVICE, type FseventsWatcher } from "./watchers";

export interface ChurnReportContext {
    root: string;
    elapsedMs: number;
    /** True when Ctrl-C ended the sample before its deadline. */
    interrupted: boolean;
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
    return `${count.toLocaleString("en-US")} ${count === 1 ? noun : pluralNoun}`;
}

function formatShare(share: number): string {
    if (share > 0 && share < 0.001) {
        return "<0.1%";
    }

    return `${(share * 100).toFixed(1)}%`;
}

/** A padded table whose last column is never shortened: a path is what the reader copies next. */
function paddedTable(headers: string[], rows: string[][]): string {
    return formatTable(rows, headers, { alignRight: [0, 1], maxColWidth: Number.MAX_SAFE_INTEGER })
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
}

/** The ranked churn report as plain text. */
export function formatChurnReport(profile: ChurnProfile, context: ChurnReportContext): string {
    const seconds = (context.elapsedMs / 1000).toFixed(1);
    const sampled = context.interrupted ? `${seconds} s, stopped early` : `${seconds} s`;

    if (profile.total === 0) {
        return `No file system events under ${context.root} (${sampled}).`;
    }

    const rows = profile.top.map((entry) => [
        entry.count.toLocaleString("en-US"),
        formatShare(entry.share),
        entry.directory,
    ]);
    const events = plural(profile.total, "event");
    const directories = plural(profile.distinctDirectories, "directory", "directories");

    return [
        `${events} in ${directories} under ${context.root} (${sampled}).`,
        "",
        `Top ${profile.top.length} most active:`,
        paddedTable(["EVENTS", "SHARE", "DIRECTORY"], rows),
        "",
        "Look for caches, build output directories and cloud sync folders in this list.",
    ].join("\n");
}

/** The processes that opened the FSEvents device, as plain text. */
export function formatWatchersReport(watchers: FseventsWatcher[], context: { elapsedMs: number }): string {
    const seconds = (context.elapsedMs / 1000).toFixed(1);

    if (watchers.length === 0) {
        return [
            `No process opened ${FSEVENTS_DEVICE} during the ${seconds} s sample.`,
            "fs_usage only sees a process while it opens the device, so a watcher that was already running stays hidden.",
            "Run it again with a longer --duration, or restart the app you suspect.",
        ].join("\n");
    }

    const rows = watchers.map((watcher) => [
        watcher.opens.toLocaleString("en-US"),
        watcher.threadIds.length.toLocaleString("en-US"),
        watcher.command,
    ]);

    return [
        `${plural(watchers.length, "process", "processes")} opened ${FSEVENTS_DEVICE} during the ${seconds} s sample:`,
        paddedTable(["OPENS", "THREADS", "PROCESS"], rows),
    ].join("\n");
}

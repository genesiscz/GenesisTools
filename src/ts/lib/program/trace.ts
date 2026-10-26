import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";

/** One event of a `tsc --generateTrace` trace.json (Chrome trace format). */
interface TraceEvent {
    ph: string;
    cat?: string;
    name: string;
    ts: number;
    dur?: number;
    args?: { path?: string; pos?: number };
}

export interface TraceFile {
    file: string;
    ms: number;
}

export interface TraceHotSpot {
    file: string;
    line: number;
    event: string;
    ms: number;
    /** The source line, trimmed. */
    source: string;
}

export interface TraceReport {
    checkMs: number;
    files: TraceFile[];
    hotSpots: TraceHotSpot[];
}

/** A trace path relative to the project. tsc lowercases trace paths on a case-insensitive disk, so compare lowercased. */
function relativeTo(root: string, path: string): string {
    const prefix = `${root.replace(/\/$/, "")}/`;
    return path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : path;
}

/**
 * `checkSourceFile` time per file, and the slowest single check events with their source line. Nested events
 * overlap: a statement's time includes the expressions inside it, so one hot expression shows on several lines.
 */
export function analyzeTrace(options: {
    traceJson: string;
    root: string;
    minMs?: number;
    readSource?: (path: string) => string;
}): TraceReport {
    const events: TraceEvent[] = SafeJSON.parse(options.traceJson, { strict: true });
    const minMs = options.minMs ?? 50;
    const read = options.readSource ?? ((path: string) => readFileSync(path, "utf8"));
    const files: TraceFile[] = [];
    const spots: Array<{ path: string; pos: number; event: string; ms: number }> = [];
    const open: TraceEvent[] = [];

    const take = (event: TraceEvent, ms: number) => {
        const path = event.args?.path;

        if (!path) {
            return;
        }

        if (event.name === "checkSourceFile") {
            files.push({ file: path, ms });
        } else if (event.cat === "check" && ms >= minMs) {
            spots.push({ path, pos: event.args?.pos ?? 0, event: event.name, ms });
        }
    };

    for (const event of events) {
        if (event.ph === "X") {
            take(event, (event.dur ?? 0) / 1000);
        } else if (event.ph === "B") {
            open.push(event);
        } else if (event.ph === "E") {
            const begin = open.pop();

            if (begin) {
                take(begin, (event.ts - begin.ts) / 1000);
            }
        }
    }

    // One line index per source: a slow nested event costs a binary search, not a split of the file.
    const sources = new Map<string, { lines: string[]; starts: number[] }>();
    const hotSpots: TraceHotSpot[] = [];
    const seen = new Set<string>();

    for (const spot of spots.sort((a, b) => b.ms - a.ms)) {
        let source = sources.get(spot.path);

        if (source === undefined) {
            let text = "";

            try {
                text = read(spot.path);
            } catch {
                // An unreadable source still lists the spot, at line 1 with no text.
            }

            const lines = text.split("\n");
            const starts: number[] = [];
            let at = 0;

            for (const line of lines) {
                starts.push(at);
                at += line.length + 1;
            }

            source = { lines, starts };
            sources.set(spot.path, source);
        }

        const line = lineOf(source.starts, spot.pos);
        const key = `${spot.path}:${line}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        hotSpots.push({
            file: relativeTo(options.root, spot.path),
            line,
            event: spot.event,
            ms: Math.round(spot.ms),
            source: (source.lines[line - 1] ?? "").trim().slice(0, 140),
        });
    }

    return {
        checkMs: Math.round(files.reduce((sum, file) => sum + file.ms, 0)),
        files: files
            .map((file) => ({ file: relativeTo(options.root, file.file), ms: Math.round(file.ms) }))
            .sort((a, b) => b.ms - a.ms),
        hotSpots,
    };
}

/** The 1-based line that holds `pos`, given each line's start offset in ascending order. */
function lineOf(starts: number[], pos: number): number {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
        const mid = (low + high + 1) >> 1;

        if ((starts[mid] ?? 0) <= pos) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    return low + 1;
}

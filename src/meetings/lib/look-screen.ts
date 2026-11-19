import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { readLines } from "@genesiscz/utils/fs/read-lines";
import { z } from "zod";
import type { CallTimeline } from "./call-timeline";
import { ocrPath } from "./frame-index";
import { parseJsonLine } from "./ndjson-lines";
import { ocrLineSchema } from "./screen";

const textRow = ocrLineSchema.extend({ failed: z.string().optional() });
type ScreenText = { displayId?: number; atSec: number; text: string };

type Position = { atMs: number; start: number; end: number };
type ScreenIndex = Map<number | undefined, Position[]>;
const indexes = new FileIdentityCache<Promise<ScreenIndex>>({ limit: 4 });

async function indexScreen(file: string): Promise<ScreenIndex> {
    const index: ScreenIndex = new Map();
    let start = 0;
    for await (const line of readLines(file)) {
        const end = start + Buffer.byteLength(line);
        // ocrRowOf writes these fields before the potentially large text and blocks. Old key orders are read once
        // during indexing. Full validation of modern rows happens only when a lookup selects their byte ranges.
        const header = /^\{"file":"(?:[^"\\]|\\.)*","at":"([^"\\]+)","displayId":(\d+)(?=,|\})/u.exec(line);
        const legacy = header ? undefined : textRow.safeParse(parseJsonLine(line, file));
        const at = header?.[1] ?? (legacy?.success ? legacy.data.at : undefined);
        const atMs = at === undefined ? NaN : Date.parse(at);
        if (Number.isFinite(atMs)) {
            const display = header
                ? header[2] === undefined
                    ? undefined
                    : Number(header[2])
                : legacy?.success
                  ? legacy.data.displayId
                  : undefined;
            const positions = index.get(display) ?? [];
            positions.push({ atMs, start, end });
            index.set(display, positions);
        }
        start = end + 1;
    }
    for (const positions of index.values()) {
        positions.sort((a, b) => a.atMs - b.atMs);
    }
    return index;
}

/** First position in a display's sorted index that belongs in the window. */
function firstInWindow(positions: Position[], fromMs: number): number {
    let low = 0;
    let high = positions.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (positions[middle]!.atMs < fromMs) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

/** OCR may finish out of capture order. Read the closed window plus the latest valid baseline per display. */
export async function screenTextChanges(options: {
    folder: string;
    timeline: CallTimeline;
    fromSec: number;
    toSec: number;
}) {
    const { folder, timeline, fromSec, toSec } = options;
    const file = ocrPath(folder);
    const identity = fileIdentity(file);
    if (!identity) {
        return null;
    }

    let pending = indexes.get(file, identity);
    if (!pending) {
        pending = indexScreen(file);
        indexes.set(file, identity, pending);
    }
    let index: ScreenIndex;
    try {
        index = await pending;
    } catch (error) {
        if (indexes.get(file, identity) === pending) {
            indexes.delete(file);
        }
        throw error;
    }

    const source = Bun.file(file);
    const read = async (
        { atMs, start, end }: Position,
        display: number | undefined
    ): Promise<ScreenText | undefined> => {
        const row = textRow.safeParse(parseJsonLine(await source.slice(start, end).text(), file));
        if (
            row.success &&
            row.data.failed === undefined &&
            !row.data.pending &&
            row.data.displayId === display &&
            Date.parse(row.data.at) === atMs
        ) {
            return { atSec: timeline.secAt(atMs), displayId: display, text: row.data.text };
        }
    };
    const before = new Map<number | undefined, ScreenText>();
    const rows: ScreenText[] = [];
    const toMs = timeline.msAt(toSec);
    for (const [display, positions] of index) {
        const first = firstInWindow(positions, timeline.msAt(fromSec));
        for (let i = first - 1; i >= 0; i--) {
            const row = await read(positions[i]!, display);
            if (row) {
                before.set(display, row);
                break;
            }
        }
        for (let i = first; i < positions.length && positions[i]!.atMs <= toMs; i++) {
            const row = await read(positions[i]!, display);
            if (row) {
                rows.push(row);
            }
        }
    }
    if (!Bun.deepEquals(identity, fileIdentity(file))) {
        throw new Error("Screen text changed during the read. Try the window again.");
    }

    const linesOf = (text: string) =>
        new Set(
            text
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter(Boolean)
        );
    const previous = new Map([...before].map(([display, row]) => [display, linesOf(row.text)] as const));
    return rows
        .sort((a, b) => a.atSec - b.atSec)
        .flatMap(({ atSec, displayId, text }) => {
            const prior = previous.get(displayId) ?? new Set<string>();
            const current = linesOf(text);
            previous.set(displayId, current);
            const added = [...current].filter((line) => !prior.has(line));
            const removed = [...prior].filter((line) => !current.has(line));
            return added.length || removed.length ? [{ atSec, displayId, added, removed }] : [];
        });
}

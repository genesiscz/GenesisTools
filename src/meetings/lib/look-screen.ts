import { existsSync } from "node:fs";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { z } from "zod";
import type { CallTimeline } from "./call-timeline";
import { ocrPath } from "./frame-index";
import { parseJsonLine } from "./ndjson-lines";
import { ocrLineSchema } from "./screen";

const textRow = ocrLineSchema.extend({ failed: z.string().optional() });
type ScreenText = { displayId?: number; atSec: number; text: string };

/** OCR may finish out of capture order. Keep just the window and one earlier baseline per display. */
export function screenTextChanges(options: { folder: string; timeline: CallTimeline; fromSec: number; toSec: number }) {
    const file = ocrPath(options.folder);
    if (!existsSync(file)) {
        return null;
    }

    const before = new Map<number | undefined, ScreenText>();
    const rows: ScreenText[] = [];
    for (const line of readLinesSync(file)) {
        const row = textRow.safeParse(parseJsonLine(line, file));
        if (!row.success || row.data.failed !== undefined || row.data.pending) {
            continue;
        }

        const { at, displayId, text } = row.data;
        const atSec = options.timeline.secAt(Date.parse(at));
        if (!Number.isFinite(atSec) || atSec > options.toSec) {
            continue;
        }

        if (atSec >= options.fromSec) {
            rows.push({ atSec, displayId, text });
        } else if (atSec >= (before.get(displayId)?.atSec ?? -Infinity)) {
            before.set(displayId, { atSec, displayId, text });
        }
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

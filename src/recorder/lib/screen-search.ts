import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { foldText } from "@genesiscz/utils/macos/ocr-boxes";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { z } from "zod";
import { readDisplayPlan } from "./proxy";

const ocrRowSchema = z.object({ file: z.string(), text: z.string(), displayId: z.number().optional() });
const sidecarSchema = z.object({ text: z.string() });

export interface ScreenHit {
    /** Seconds on the recording's clock (the proxy movie's and the editor's source time). */
    sec: number;
    displayId?: number;
    file: string;
    /** The OCR lines of the frame that hold the query. */
    lines: string[];
    /** The proxy movie shows this display then (always true without a display plan). */
    shown: boolean;
}

/** Each frame's OCR text: a meeting's (or a jsonl-sink recording's) `ocr.jsonl`, else the `<frame>.ocr.json` sidecars. */
function frameTexts(folder: string, files: string[]): Map<string, string> {
    const texts = new Map<string, string>();
    const jsonl = join(folder, "ocr.jsonl");

    if (existsSync(jsonl)) {
        for (const line of readFileSync(jsonl, "utf8").split("\n")) {
            const row = line.trim() ? ocrRowSchema.safeParse(SafeJSON.parse(line, { strict: true })) : undefined;

            if (row?.success) {
                texts.set(row.data.file, row.data.text);
            }
        }

        return texts;
    }

    for (const file of files) {
        const sidecar = join(folder, `${file}.ocr.json`);

        if (existsSync(sidecar)) {
            const parsed = sidecarSchema.safeParse(SafeJSON.parse(readFileSync(sidecar, "utf8"), { strict: true }));

            if (parsed.success) {
                texts.set(file, parsed.data.text);
            }
        }
    }

    return texts;
}

/**
 * Where a text was on the screen in a frames recording (a library recording with OCR, or a meeting): every frame whose
 * OCR holds `query` (without case and diacritics), with its time on the recording's clock, oldest first.
 */
export function findOnScreen(folder: string, query: string, { limit = 50 }: { limit?: number } = {}): ScreenHit[] {
    const manifest = readRecordingManifest(folder);

    if (!manifest) {
        throw new Error(`${folder} has no recording.json; make the proxy first (it writes one for a meeting)`);
    }

    const wanted = foldText(query);

    if (!wanted) {
        return [];
    }

    const texts = frameTexts(
        folder,
        manifest.frames.map((frame) => frame.file)
    );
    const plan = readDisplayPlan(folder);
    const hits: ScreenHit[] = [];

    for (const frame of [...manifest.frames].sort((a, b) => a.atMs - b.atMs)) {
        const lines = (texts.get(frame.file) ?? "").split("\n").filter((line) => foldText(line).includes(wanted));

        if (lines.length === 0) {
            continue;
        }

        const atUs = frame.atMs * 1000;
        const range = plan?.ranges.find(
            (one, index) => atUs >= one.fromUs && (atUs < one.toUs || index === plan.ranges.length - 1)
        );
        hits.push({
            sec: frame.atMs / 1000,
            ...(frame.displayId !== undefined ? { displayId: frame.displayId } : {}),
            file: frame.file,
            lines,
            shown: !plan || frame.displayId === undefined || range?.displayId === frame.displayId,
        });

        if (hits.length >= limit) {
            break;
        }
    }

    return hits;
}

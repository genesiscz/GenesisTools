import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { type CopyFile, cloneOrCopy } from "@genesiscz/utils/fs/clone";
import { type Block, builtinConverters, renderBlocks, renderFrontmatter } from "@genesiscz/utils/json2md";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { OcrLine } from "./screen";
import { readOcrRows } from "./screen-boxes";

const { log } = logger.scoped("meetings-screen-note");

/** How the note's pictures were put in place: a clone costs no disk space, a copy does. */
export interface PlacedFrames {
    /** A frame's file as `ocr.jsonl` names it (`frames/x.jpg`) → the link the note writes, relative to the note. */
    links: Map<string, string>;
    cloned: number;
    copied: number;
    /** Already beside the note from an earlier run, or already under the note's folder. */
    kept: number;
    /** Frames `ocr.jsonl` names that are not on disk; the note shows no picture for them. */
    missing: string[];
}

export interface ScreenNoteResult extends PlacedFrames {
    notePath: string;
    framesDir: string;
    frames: number;
    shown: number;
}

/** The folder beside a note that holds its pictures: `<note name>.frames/`. */
export function noteFramesDir(notePath: string): string {
    return join(dirname(notePath), `${basename(notePath, extname(notePath))}.frames`);
}

/**
 * Puts each frame the note shows where Genesis Markdown may show it: inside the vault or under the note's own folder.
 * A frame already under the note's folder is linked where it is. Any other frame gets an APFS clone in
 * `<note name>.frames/` (clonefile: the clone shares the frame's blocks, so it costs no disk space), or a plain copy
 * where the volume cannot clone (another volume, HFS+). A file already in that folder is kept, so a second run writes
 * nothing. `copyFile` is the clone primitive, for a test that makes the clone fail.
 */
export function placeNoteFrames({
    meetingFolder,
    files,
    notePath,
    copyFile,
}: {
    meetingFolder: string;
    files: string[];
    notePath: string;
    copyFile?: CopyFile;
}): PlacedFrames {
    const noteDir = dirname(resolve(notePath));
    const framesDir = noteFramesDir(resolve(notePath));
    const placed: PlacedFrames = { links: new Map(), cloned: 0, copied: 0, kept: 0, missing: [] };

    for (const file of new Set(files)) {
        const source = resolve(meetingFolder, file);
        const destination = join(framesDir, basename(file));
        if (existsSync(destination)) {
            placed.links.set(file, linkPath(relative(noteDir, destination)));
            placed.kept++;
            continue;
        }

        if (!existsSync(source)) {
            placed.missing.push(file);
            continue;
        }

        if (isUnder(source, noteDir)) {
            placed.links.set(file, linkPath(relative(noteDir, source)));
            placed.kept++;
            continue;
        }

        placed.links.set(file, linkPath(relative(noteDir, destination)));

        mkdirSync(framesDir, { recursive: true });
        const how = cloneOrCopy({ source, destination, mode: 0o644, mayCopy: true, ...(copyFile ? { copyFile } : {}) });

        if (how === "cloned") {
            placed.cloned++;
        } else {
            placed.copied++;
            log.debug({ source, destination }, "frame copied: the volume cannot clone it");
        }
    }

    if (placed.copied > 0) {
        log.warn(
            { framesDir, copied: placed.copied, cloned: placed.cloned },
            `${placed.copied} frames were copied, not cloned: this volume pair cannot make an APFS clone, so the copies use disk space`
        );
    }

    log.debug(
        { framesDir, cloned: placed.cloned, copied: placed.copied, kept: placed.kept, missing: placed.missing.length },
        "screen note frames placed"
    );
    return placed;
}

/**
 * The screen note's markdown: one section per frame whose text changed on its display, with its picture and its text.
 * Times are local time and the transcript time (`zeroMs` is transcript second 0).
 */
export function screenNoteMarkdown({
    record,
    rows,
    zeroMs,
    links,
    ocrPath,
    picturesLabel,
}: {
    record: MeetingRecord;
    rows: OcrLine[];
    zeroMs: number;
    links: Map<string, string>;
    ocrPath: string;
    picturesLabel: string;
}): { markdown: string; shown: number } {
    const names = new Map((record.recording?.displays ?? []).map((display) => [display.id, display.name]));
    const shown = shownRows(rows);
    const blocks: Block[] = [
        { h1: `Screen OCR: ${record.title}` },
        {
            p: `Source: \`${ocrPath}\` (${rows.length} frames; ${shown.length} shown here, a frame whose text did not change on its display is left out). Pictures: \`${picturesLabel}\`. Times are local time and the transcript time.`,
        },
    ];

    for (const row of shown) {
        const atMs = Date.parse(row.at);
        const display =
            row.displayId === undefined ? "screen" : (names.get(row.displayId) ?? `display ${row.displayId}`);
        const link = links.get(row.file);
        const text = row.text.trim() || "(no text)";
        blocks.push(
            { h2: `${clockTime(atMs)} · transcript ${formatClock(Math.max(0, (atMs - zeroMs) / 1000))} · ${display}` },
            link ? { img: { source: link, escapeSource: false } } : { p: `_The picture ${row.file} is not on disk._` },
            { code: { language: "text", content: text } }
        );
    }

    const frontmatter = renderFrontmatter(`meeting: ${record.id}`);
    const body = renderBlocks(blocks, { options: {}, converters: builtinConverters() });
    return { markdown: `${frontmatter}\n\n${body}\n${shown.length === 0 ? "\n" : ""}`, shown: shown.length };
}

/**
 * Writes the screen note of a meeting to `notePath` and places the pictures it shows beside it. An existing file is
 * replaced only when it is this meeting's screen note, so a wrong `--out` never overwrites another note.
 */
export function writeScreenNote({
    record,
    meetingFolder,
    notePath,
    zeroMs,
    copyFile,
}: {
    record: MeetingRecord;
    meetingFolder: string;
    notePath: string;
    zeroMs: number;
    copyFile?: CopyFile;
}): ScreenNoteResult {
    const target = resolve(notePath);

    if (existsSync(target) && !isScreenNoteOf(readFileSync(target, "utf8"), record.id)) {
        throw new Error(`${target} is not the screen note of ${record.id}; it is left as it is. Pick another --out.`);
    }

    const ocrPath = join(meetingFolder, "ocr.jsonl");
    const rows = readOcrRows(ocrPath);
    const shownFiles = shownRows(rows).map((row) => row.file);
    const placed = placeNoteFrames({
        meetingFolder,
        files: shownFiles,
        notePath: target,
        ...(copyFile ? { copyFile } : {}),
    });
    const framesDir = noteFramesDir(target);
    const picturesLabel = existsSync(framesDir) ? `${basename(framesDir)}/` : join(meetingFolder, "frames") + sep;
    const { markdown, shown } = screenNoteMarkdown({
        record,
        rows,
        zeroMs,
        links: placed.links,
        ocrPath,
        picturesLabel,
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown);
    log.debug({ notePath: target, frames: rows.length, shown }, "screen note written");
    return { ...placed, notePath: target, framesDir, frames: rows.length, shown };
}

/** The rows the note shows: a frame whose text is the same as the display's frame before is left out. */
function shownRows(rows: OcrLine[]): OcrLine[] {
    const lastText = new Map<number | undefined, string>();
    return rows.filter((row) => {
        const text = row.text.trim();

        if (lastText.get(row.displayId) === text) {
            return false;
        }

        lastText.set(row.displayId, text);
        return true;
    });
}

function isScreenNoteOf(text: string, meetingId: string): boolean {
    const head = text.slice(0, 400);
    return head.startsWith("---\n") && head.includes(`\nmeeting: ${meetingId}\n`) && head.includes("\n# Screen OCR: ");
}

function isUnder(path: string, folder: string): boolean {
    const rel = relative(folder, path);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

/** A relative path as a markdown link target: forward slashes, each segment percent-encoded (spaces, parentheses). */
function linkPath(rel: string): string {
    return rel
        .split(/[/\\]/)
        .map((segment) =>
            encodeURIComponent(segment).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
        )
        .join("/");
}

function clockTime(ms: number): string {
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

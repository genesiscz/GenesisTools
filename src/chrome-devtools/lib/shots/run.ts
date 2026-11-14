/**
 * Runs a shot book: one browser and one tab for the run, every part of every selected shot, the parts stacked into
 * one image, and the files the first shot script writes: `<stem>.<tag>.webp` (annotated, at most 1200 px wide at
 * quality 60 unless the book says otherwise) in the output folder, a full-size annotated PNG under `png/` when the book
 * asks, the raw image as `png/<stem>.<tag>.original.png` only with `raw`, and the marks (in the raw image's pixels)
 * plus a run manifest under `.shots/<tag>/`. A failing shot is reported by name and the run goes on.
 */
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { capturePart, rehearsePart } from "@genesiscz/utils/chrome-devtools/shots/page";
import { type Annotation, composeOverlay, encodeImage, stackImages } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type BrowserKind, type Shot, type ShotBook, type ShotTab, selectShots } from "./book.ts";
import { openShotBrowser } from "./browsers.ts";

const { log } = logger.scoped("chrome-devtools:shots");

export interface RunOptions {
    only?: readonly string[];
    tag: string;
    out: string;
    /** Overrides the book's `browser.use`. */
    use?: BrowserKind;
    port?: number;
    /** Also write the raw image (overrides the book's `output.raw`). */
    raw?: boolean;
    onResult?: (result: ShotResult) => void;
}

export type ShotResult =
    | { status: "ok"; id: string; stem: string; files: string[]; notes: string[]; ms: number }
    | { status: "failed"; id: string; stem: string; problems: string[] };

export interface RunReport {
    book: string;
    tag: string;
    out: string;
    browser: BrowserKind;
    reproducible: boolean;
    results: ShotResult[];
    manifest: string;
}

/** The first shot script's default tag: month and day, `1109` for 9 November. */
export function todayTag(now = new Date()): string {
    return `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

/** Writes through a temporary name, so a crash keeps the previous file whole. */
async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await Bun.write(temporary, data);
    renameSync(temporary, path);
}

/** Moves one pixel annotation down by `dy`, where its part sits in the stacked image. */
function shiftedDown(annotation: Annotation, dy: number): Annotation {
    switch (annotation.kind) {
        case "highlight":
        case "box":
        case "ellipse":
        case "blur":
        case "crop": {
            const rect =
                typeof annotation.rect === "string"
                    ? annotation.rect
                    : { ...annotation.rect, y: annotation.rect.y + dy };
            return { ...annotation, rect };
        }
        case "arrow":
            return {
                ...annotation,
                from: { ...annotation.from, y: annotation.from.y + dy },
                to: { ...annotation.to, y: annotation.to.y + dy },
            };
        case "label":
            return { ...annotation, at: { ...annotation.at, y: annotation.at.y + dy } };
        case "grid":
            return annotation;
    }
}

function shifted(annotations: readonly Annotation[], dy: number): Annotation[] {
    return annotations.map((annotation) => shiftedDown(annotation, dy));
}

async function shootOne(tab: ShotTab, book: ShotBook, shot: Shot, options: RunOptions): Promise<ShotResult> {
    const started = Date.now();
    const raws: Buffer[] = [];
    const finals: Buffer[] = [];
    const annotations: Annotation[] = [];
    const notes: string[] = [];
    let offset = 0;
    const setup = tab.shared ? { ...book.setup, viewport: undefined } : book.setup;
    const wantsRaw = options.raw ?? book.output.raw;

    for (const [index, part] of shot.parts.entries()) {
        const capture = await capturePart(tab.cdp, part, setup);
        const where = shot.parts.length > 1 ? `part ${index} ` : "";
        if (!capture.ok) {
            return {
                status: "failed",
                id: shot.id,
                stem: shot.stem,
                problems: capture.problems.map((problem) => `${where}${problem}`),
            };
        }

        if (wantsRaw) {
            raws.push(capture.images.raw);
        }

        finals.push(await composeOverlay(capture.images));
        annotations.push(...shifted(capture.images.annotations, offset));
        notes.push(...capture.notes.map((note) => `${where}${note}`));
        offset += capture.images.height;
    }

    const annotated = await stackImages(finals);
    const name = `${shot.stem}.${options.tag}`;
    const files: string[] = [];
    for (const format of book.output.formats) {
        const path = join(format === "png" ? join(options.out, "png") : options.out, `${name}.${format}`);
        await writeAtomic(path, await encodeImage(annotated, format, book.output.webp));
        files.push(path);
    }

    if (wantsRaw) {
        const path = join(options.out, "png", `${name}.original.png`);
        await writeAtomic(path, await stackImages(raws));
        files.push(path);
    }

    const marks = join(options.out, ".shots", options.tag, `${shot.stem}.marks.json`);
    await writeAtomic(marks, `${SafeJSON.stringify({ preset: book.setup.preset, annotations }, null, 2)}\n`);
    files.push(marks);

    return { status: "ok", id: shot.id, stem: shot.stem, files, notes, ms: Date.now() - started };
}

async function withTab<T>(
    book: ShotBook,
    options: Pick<RunOptions, "use" | "port">,
    work: (tab: ShotTab, reproducible: boolean) => Promise<T>
): Promise<T> {
    const use = options.use ?? book.use;
    const browser = await openShotBrowser(use, book.browser, {
        ...(book.base ? { base: book.base } : {}),
        ...(options.port !== undefined ? { port: options.port } : {}),
    });
    try {
        const tab = await browser.openTab();
        try {
            return await work(tab, browser.reproducible);
        } finally {
            await tab.close();
        }
    } finally {
        await browser.close();
    }
}

export async function runShots(book: ShotBook, options: RunOptions): Promise<RunReport> {
    const shots = selectShots(book, options.only);
    const use = options.use ?? book.use;
    return withTab(book, options, async (tab, reproducible) => {
        const results: ShotResult[] = [];
        for (const shot of shots) {
            const result = await shootOne(tab, book, shot, options).catch(
                (error: unknown): ShotResult => ({
                    status: "failed",
                    id: shot.id,
                    stem: shot.stem,
                    problems: [error instanceof Error ? error.message : String(error)],
                })
            );
            log.info({ id: shot.id, status: result.status }, "shot");
            options.onResult?.(result);
            results.push(result);
        }

        const manifest = join(options.out, ".shots", options.tag, "run.json");
        const report: RunReport = {
            book: book.file,
            tag: options.tag,
            out: options.out,
            browser: use,
            reproducible,
            results,
            manifest,
        };
        await writeAtomic(manifest, `${SafeJSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`);
        return report;
    });
}

export type RehearsalResult =
    | { status: "ok"; id: string; stem: string; notes: string[] }
    | { status: "failed"; id: string; stem: string; problems: string[] };

/** Every selected part's page state, locators and labels, with no image: what `shots run` would fail on. */
export async function rehearseShots(
    book: ShotBook,
    options: Pick<RunOptions, "only" | "use" | "port">
): Promise<RehearsalResult[]> {
    const shots = selectShots(book, options.only);
    return withTab(book, options, async (tab) => {
        const results: RehearsalResult[] = [];
        const setup = tab.shared ? { ...book.setup, viewport: undefined } : book.setup;
        for (const shot of shots) {
            const problems: string[] = [];
            const notes: string[] = [];
            for (const [index, part] of shot.parts.entries()) {
                const where = shot.parts.length > 1 ? `part ${index} ` : "";
                const rehearsal = await rehearsePart(tab.cdp, part, setup).catch((error: unknown) => ({
                    ok: false as const,
                    problems: [error instanceof Error ? error.message : String(error)],
                }));
                if (rehearsal.ok) {
                    notes.push(...rehearsal.notes.map((note) => `${where}${note}`));
                } else {
                    problems.push(...rehearsal.problems.map((problem) => `${where}${problem}`));
                }
            }

            results.push(
                problems.length > 0
                    ? { status: "failed", id: shot.id, stem: shot.stem, problems }
                    : { status: "ok", id: shot.id, stem: shot.stem, notes }
            );
        }

        return results;
    });
}

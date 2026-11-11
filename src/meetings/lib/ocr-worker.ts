import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { closeDarwinKit } from "@genesiscz/utils/macos/darwinkit";
import type { OcrResult } from "@genesiscz/utils/macos/types";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { claimPidFile, clearPidFile, inspectPidFile } from "@genesiscz/utils/process/pidfile";
import { type RecorderSettings, recorderSettingsSchema } from "@genesiscz/utils/screen-recorder/control";
import {
    CAPTURE_FILE_MODE,
    FrameReader,
    type ImageCropper,
    type OcrRecognizer,
    type OcrRow,
    ocrRowOf,
    visionOcr,
} from "@genesiscz/utils/screen-recorder/frame-output";
import { OCR_SKIP_REASONS } from "@genesiscz/utils/screen-recorder/ocr-region";
import type { MotionBox } from "@genesiscz/utils/screen-recorder/types";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import {
    type FrameIndexRow,
    FrameIndexTail,
    frameIndexPath,
    indexRowOf,
    ocrBacklog,
    ocrPath,
    ocrRowFiles,
    readFrameIndex,
} from "./frame-index";
import { EMPTY_FRAME_CHARS, readRecorderState } from "./recorder-shared";

/**
 * The second phase of a meeting recording: OCR of the kept frames, in a process of its own (`tools meetings ocr`).
 * The recorder only keeps frames and lists each in `frames.jsonl`; this worker reads the frames that have no
 * `ocr.jsonl` row yet, in index order (each display's previous read decides what its next frame needs), and appends
 * their rows. One worker per meeting (`ocr.pid`); a restart goes on where `ocr.jsonl` ends.
 */

const { log } = logger.scoped("meetings-ocr");

export const OCR_PID_FILE = "ocr.pid";
/** Reads that throw in a row, after which the worker starts a fresh OCR helper (and after the next run, gives up). */
export const OCR_FAILURES_BEFORE_RESTART = 3;
/** How often a following worker looks at the index when no file event came. */
const FOLLOW_POLL_MS = 5_000;
/** A following worker ends after this even while the recorder runs; the watcher starts the next one. */
const FOLLOW_CEILING_MS = 24 * 3_600_000;
/** Meetings whose backlog `ensureOcrWorkers` looks at: the ones started in this many days. */
const RECENT_DAYS = 2;
const DAY_MS = 86_400_000;

/** Where a meeting's frames are read: the recognizer, and a way to throw its helper away for a fresh one. */
export interface OcrEngine {
    recognize: OcrRecognizer;
    /** Ends the helper; the next read starts a new one. */
    restart(): void;
}

/**
 * Vision through the shared DarwinKit client. A long-lived helper can get stuck: on 2026-11-11 one answered every read
 * with `TextRecognition.CRImageReaderError error 1` for an hour while a fresh process read the same files.
 */
export const visionOcrEngine: OcrEngine = { recognize: visionOcr, restart: () => closeDarwinKit() };

/** The OCR settings of a meeting recording: every frame is read, a read of any length is kept. */
export function meetingOcrSettings(
    capture: MeetingsConfig["global"]["capture"],
    languages: string[]
): RecorderSettings["ocr"] {
    return {
        enabled: true,
        languages,
        minChars: 0,
        threshold: capture.ocr.threshold * 100,
        skipTextless: capture.ocr.skipTextless,
        region: capture.ocr.region,
        read: capture.ocr.read,
        tilePx: capture.ocr.tilePx,
    };
}

/** The OCR settings the recording runs with now, beside its frames (`LiveOcrSettings`). */
export const OCR_SETTINGS_FILE = "ocr-settings.json";

/** The words of the hint a first frame with almost no text gives, in `recording.ocrWarning` and `record status`. */
export const FIRST_FRAME_HINT = `The first frame holds almost no readable text: Screen Recording may be missing (macOS then returns only the desktop; check ${toolCommand("control", "doctor")}), or the text is too small for capture.resolutionCap.`;

/**
 * The OCR settings of a running recording, in the meeting folder: the recorder writes them at its start and at each
 * live change (`record set --ocr-min-chars`, `settings.set`), and the worker reads them before each frame, so a change
 * reaches the next frame it reads without a restart. Without the file (a meeting from before it, a worker run by
 * hand) the worker keeps the settings it started with.
 */
export class LiveOcrSettings {
    private written?: string;
    private seen?: { signature: string; settings: RecorderSettings["ocr"] | undefined };

    constructor(readonly path: string) {}

    /** Writes the settings when they differ from the last write. */
    write(settings: RecorderSettings["ocr"]): void {
        const text = SafeJSON.stringify(settings, null, 2);

        if (text === this.written) {
            return;
        }

        atomicWriteFileSync(this.path, text, { mode: CAPTURE_FILE_MODE });
        this.written = text;
        log.debug({ path: this.path }, "the recording's OCR settings written");
    }

    /** The settings in the file, or `fallback` without a readable file; the file is parsed again only when it changed. */
    read(fallback: RecorderSettings["ocr"]): RecorderSettings["ocr"] {
        if (!existsSync(this.path)) {
            return fallback;
        }

        const stat = statSync(this.path);
        const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;

        if (this.seen?.signature !== signature) {
            this.seen = { signature, settings: this.parse() };
            log.info({ path: this.path, settings: this.seen.settings }, "OCR settings read from the recording");
        }

        return this.seen.settings ?? fallback;
    }

    private parse(): RecorderSettings["ocr"] | undefined {
        try {
            const parsed = recorderSettingsSchema.shape.ocr.safeParse(
                SafeJSON.parse(readFileSync(this.path, "utf8"), { strict: true })
            );

            if (parsed.success) {
                return parsed.data;
            }

            log.warn({ path: this.path, error: parsed.error.message }, "the OCR settings file does not parse");
        } catch (error) {
            log.warn({ path: this.path, error }, "the OCR settings file could not be read");
        }

        return undefined;
    }
}

export function ocrPidPath(folder: string): string {
    return join(folder, OCR_PID_FILE);
}

/** Whether a live worker holds the meeting's OCR. */
export function ocrWorkerRunning(folder: string): boolean {
    return inspectPidFile(ocrPidPath(folder)).status === "live";
}

/** A number Vision gave: the recorder and DarwinKit wrote block bounds as numeric strings (`"x":"0.1099"`). */
const storedNumber = z.union([z.number(), z.string().trim().min(1).pipe(z.coerce.number())]);

/** The part of a stored row that makes its frame done: its file. Nothing else of the row needs to parse. */
const storedRowFileSchema = z.looseObject({ file: z.string(), at: z.string().default("") });

/** A row of `ocr.jsonl` as written by any version: old rows lack the display, the change and the reason. */
const storedOcrRowSchema = z.looseObject({
    file: z.string(),
    at: z.string(),
    displayId: z.number().optional(),
    changePercent: z.number().optional(),
    reason: z.string().optional(),
    text: z.string().default(""),
    blocks: z
        .array(
            z.object({
                text: z.string(),
                confidence: storedNumber,
                bounds: z.object({ x: storedNumber, y: storedNumber, width: storedNumber, height: storedNumber }),
            })
        )
        .default([]),
    skipped: z.enum(OCR_SKIP_REASONS).optional(),
    regions: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
    failed: z.string().optional(),
});

/**
 * One line of `ocr.jsonl` with its row, or no row for a line that does not parse (it is kept as it is). `file` is set
 * whenever the line names a frame, also when the rest of it does not parse: that frame is done.
 */
interface OcrLine {
    line: string;
    row?: OcrRow;
    file?: string;
}

function parseOcrLine(line: string, path: string): OcrLine {
    let value: unknown;

    try {
        value = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ path, error }, "an ocr.jsonl line does not parse; kept as it is");
        return { line };
    }

    const parsed = storedOcrRowSchema.safeParse(value);

    if (!parsed.success) {
        const named = storedRowFileSchema.safeParse(value);

        if (!named.success) {
            log.debug({ path, error: parsed.error.message }, "an ocr.jsonl line is no row; kept as it is");
            return { line };
        }

        // Its frame is done; the line stays as written, and its text does not stand for the display's previous read.
        log.debug({ path, file: named.data.file, error: parsed.error.message }, "an ocr.jsonl row only partly parses");
        return { line, file: named.data.file };
    }

    const stored = parsed.data;
    // Rows from before the display, the change and the reason were kept get them from the name and the defaults.
    const row: OcrRow = {
        file: stored.file,
        at: stored.at,
        displayId: stored.displayId ?? Number(stored.file.match(/-d(\d+)\.[a-z]+$/)?.[1] ?? 0),
        changePercent: stored.changePercent ?? 0,
        reason: stored.reason ?? "change",
        text: stored.text,
        blocks: stored.blocks,
        ...(stored.skipped ? { skipped: stored.skipped } : {}),
        ...(stored.regions ? { regions: stored.regions } : {}),
        ...(stored.failed !== undefined ? { failed: stored.failed } : {}),
    };
    return { line, row, file: row.file };
}

function readOcrLines(path: string, maxBytes?: number): OcrLine[] {
    if (!existsSync(path)) {
        return [];
    }

    const text = maxBytes === undefined ? undefined : readBytes(path, 0, maxBytes);
    const lines = text === undefined ? readLinesSync(path) : text.split("\n");
    const out: OcrLine[] = [];

    for (const line of lines) {
        if (line.trim()) {
            out.push(parseOcrLine(line, path));
        }
    }

    return out;
}

function readBytes(path: string, from: number, to: number): string {
    const length = Math.max(0, to - from);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");

    try {
        const read = readSync(fd, buffer, 0, length, from);
        return buffer.subarray(0, read).toString("utf8");
    } finally {
        closeSync(fd);
    }
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function readOf(row: OcrRow): OcrResult {
    return { text: row.text, blocks: row.blocks };
}

export interface OcrWorkerOptions {
    store: MeetingStore;
    meetingId: string;
    settings: RecorderSettings["ocr"];
    /** Default: Vision through DarwinKit (`visionOcrEngine`). */
    engine?: OcrEngine;
    crop?: ImageCropper;
    /** Go on while the meeting's recorder runs, and end once it stopped and every frame has a row. */
    follow?: boolean;
    /** Read the rows written as failed again (`ocr.jsonl` is rewritten in place, in its order). */
    retryFailed?: boolean;
    /** Read every row with no text from this time on again (rows a stuck helper wrote empty). */
    rereadEmptySince?: Date;
    /** Whether the meeting's recorder runs; default: the recorder state names this meeting and its pid lives. */
    recording?: () => boolean;
    pollMs?: number;
    signal?: AbortSignal;
}

export interface OcrWorkerResult {
    meetingId: string;
    /** `busy`: another worker holds the meeting (`holder` is its pid); nothing was read. */
    status: "done" | "busy";
    holder?: number;
    /** Rows appended for frames that had none. */
    read: number;
    /** Rows read again in place (`--retry-failed`, `--reread-empty-since`). */
    reread: number;
    /** Rows written as failed (new or read again). */
    failed: number;
    /** Times the OCR helper was thrown away for a fresh one. */
    restarts: number;
}

class OcrWorker {
    readonly folder: string;
    readonly ocrFile: string;
    readonly indexFile: string;
    readonly result: OcrWorkerResult;
    private readonly engine: OcrEngine;
    private readonly reader: FrameReader;
    private failuresInRow = 0;
    private readonly done = new Set<string>();
    private readonly liveSettings: LiveOcrSettings;
    /** When the recording's last run began: its first frame gets the "almost no text" check. */
    private runStartMs = 0;
    /** The run's first frame has a row already (this worker's or an earlier one's). */
    private firstChecked = false;

    constructor(private readonly options: OcrWorkerOptions) {
        this.folder = options.store.folder(options.meetingId);
        this.ocrFile = ocrPath(this.folder);
        this.indexFile = frameIndexPath(this.folder);
        this.liveSettings = new LiveOcrSettings(join(this.folder, OCR_SETTINGS_FILE));
        const engine = options.engine ?? visionOcrEngine;
        this.engine = engine;
        this.reader = new FrameReader({
            recognize: (image, languages, readOptions) => engine.recognize(image, languages, readOptions),
            crop: options.crop,
        });
        this.result = { meetingId: options.meetingId, status: "done", read: 0, reread: 0, failed: 0, restarts: 0 };
    }

    /**
     * One frame's row. A read that throws is tried again; after `OCR_FAILURES_BEFORE_RESTART` in a row the helper is
     * thrown away, and when the fresh one fails as often, the row says `failed` instead of holding an empty read.
     */
    async readFrame(entry: FrameIndexRow): Promise<OcrRow> {
        const settings = this.settings();
        const frame = {
            file: entry.file,
            at: entry.at,
            displayId: entry.displayId,
            changePercent: entry.changePercent,
            reason: entry.reason,
        };

        if (!settings.enabled) {
            return ocrRowOf(frame, undefined, settings.minChars);
        }

        const path = join(this.folder, entry.file);

        if (!existsSync(path)) {
            this.result.failed += 1;
            log.warn({ meeting: this.options.meetingId, file: entry.file }, "a frame in the index is not on disk");
            return { ...ocrRowOf(frame, undefined, settings.minChars), failed: "the frame file is missing" };
        }

        let restarted = false;

        for (;;) {
            try {
                const outcome = await this.reader.read({ frame: entry, path, displayId: entry.displayId, settings });
                this.failuresInRow = 0;
                return ocrRowOf(frame, outcome, settings.minChars);
            } catch (err) {
                this.failuresInRow += 1;
                log.warn(
                    { err, meeting: this.options.meetingId, file: entry.file, failuresInRow: this.failuresInRow },
                    "an OCR read failed"
                );

                if (this.failuresInRow < OCR_FAILURES_BEFORE_RESTART) {
                    continue;
                }

                this.failuresInRow = 0;

                if (restarted) {
                    this.result.failed += 1;
                    log.error(
                        { err, meeting: this.options.meetingId, file: entry.file },
                        "a frame could not be read, also by a fresh OCR helper; its row says failed"
                    );
                    return { ...ocrRowOf(frame, undefined, settings.minChars), failed: errorText(err) };
                }

                this.engine.restart();
                this.result.restarts += 1;
                restarted = true;
                log.warn({ meeting: this.options.meetingId }, "the OCR helper failed in a row; a fresh one starts");
            }
        }
    }

    /**
     * `--retry-failed` and `--reread-empty-since`: the chosen rows are read again in file order (each display's
     * earlier rows stand for its previous read), and `ocr.jsonl` is replaced in one atomic write. Lines appended while
     * it read are kept after the rewritten ones.
     */
    async rewrite(): Promise<void> {
        const { retryFailed, rereadEmptySince } = this.options;

        if ((!retryFailed && !rereadEmptySince) || !existsSync(this.ocrFile)) {
            return;
        }

        if (this.recording() && !existsSync(this.indexFile)) {
            throw new Error(
                `${this.options.meetingId} is recorded by a recorder that writes ocr.jsonl itself; read its rows again after it stops`
            );
        }

        const sinceMs = rereadEmptySince?.getTime();
        const size = statSync(this.ocrFile).size;
        const lines = readOcrLines(this.ocrFile, size);
        const motion = new Map<string, MotionBox[]>();

        for (const entry of readFrameIndex(this.folder)) {
            if (entry.motionBoxes) {
                motion.set(entry.file, entry.motionBoxes);
            }
        }

        let changed = 0;

        for (const [i, current] of lines.entries()) {
            const row = current.row;

            if (!row) {
                continue;
            }

            const failed = row.failed !== undefined;
            const target =
                (retryFailed && failed) ||
                (sinceMs !== undefined && row.text.trim() === "" && Date.parse(row.at) >= sinceMs);

            if (!target) {
                if (!failed) {
                    this.reader.seed(row.displayId, readOf(row));
                }

                continue;
            }

            this.options.signal?.throwIfAborted();
            const next = await this.readFrame(indexRowOf(row, motion.get(row.file)));
            lines[i] = { line: SafeJSON.stringify(next), row: next };
            changed += 1;
        }

        if (changed === 0) {
            log.info({ meeting: this.options.meetingId }, "no ocr.jsonl row to read again");
            return;
        }

        const appended = readBytes(this.ocrFile, size, statSync(this.ocrFile).size);
        const body = `${lines.map((one) => one.line).join("\n")}\n${appended}`;
        atomicWriteFileSync(this.ocrFile, body, { mode: CAPTURE_FILE_MODE });
        this.result.reread += changed;
        log.info({ meeting: this.options.meetingId, changed }, "ocr.jsonl rows read again");
    }

    /** The rows already written: which frames are done, and each display's last read for the next frame's plan. */
    resume(): void {
        const last = new Map<number, OcrRow | undefined>();
        const spans = this.options.store.read(this.options.meetingId)?.recording?.spans ?? [];
        const runStart = spans.at(-1)?.from;
        this.runStartMs = runStart ? Date.parse(runStart) : 0;

        for (const { row, file } of readOcrLines(this.ocrFile)) {
            // A frame with a line in ocr.jsonl is done whatever the rest of its line holds: never a second row for it.
            if (file !== undefined) {
                this.done.add(file);
            }

            if (!row) {
                continue;
            }

            last.set(row.displayId, row.failed === undefined ? row : undefined);

            if (Date.parse(row.at) >= this.runStartMs) {
                this.firstChecked = true;
            }
        }

        for (const [displayId, row] of last) {
            if (row) {
                this.reader.seed(displayId, readOf(row));
            }
        }

        // A line cut short keeps the file it names at its start: its frame never gets a second row either.
        for (const file of ocrRowFiles(this.ocrFile)) {
            this.done.add(file);
        }

        log.info({ meeting: this.options.meetingId, done: this.done.size }, "OCR resumes after the written rows");
    }

    /** Reads every indexed frame that has no row yet, in index order, appending one row each. */
    async drain(tail: FrameIndexTail): Promise<void> {
        for (const entry of tail.readNew()) {
            if (this.done.has(entry.file)) {
                continue;
            }

            this.options.signal?.throwIfAborted();
            const row = await this.readFrame(entry);

            if (!this.firstChecked && Date.parse(entry.at) >= this.runStartMs) {
                this.firstChecked = true;
                await this.checkFirstFrame(row);
            }

            appendFileSync(this.ocrFile, `${SafeJSON.stringify(row)}\n`, { mode: CAPTURE_FILE_MODE });
            this.done.add(entry.file);
            this.result.read += 1;
        }
    }

    /** The settings for the next frame: the recording's live ones when it wrote them, else the ones it started with. */
    settings(): RecorderSettings["ocr"] {
        return this.liveSettings.read(this.options.settings);
    }

    /**
     * The first frame of a recording run with almost no text says why in the record's `recording.ocrWarning` (the
     * recorder's own `warning` is its notes, rewritten at its stop); `record status` and `show` print it.
     */
    private async checkFirstFrame(row: OcrRow): Promise<void> {
        const chars = row.text.trim().length;

        if (row.failed !== undefined || !this.settings().enabled || chars >= EMPTY_FRAME_CHARS) {
            return;
        }

        log.warn({ meeting: this.options.meetingId, file: row.file, chars }, FIRST_FRAME_HINT);
        await this.options.store
            .update(
                this.options.meetingId,
                { command: "meetings ocr", change: "first frame: almost no text" },
                (current) => {
                    current.recording = { ...current.recording, ocrWarning: FIRST_FRAME_HINT };
                }
            )
            .catch((err: unknown) =>
                log.warn({ err, meeting: this.options.meetingId }, "the first-frame hint could not be saved")
            );
    }

    recording(): boolean {
        if (this.options.recording) {
            return this.options.recording();
        }

        const current = readRecorderState(this.options.store);
        return current.running && current.state?.meetingId === this.options.meetingId;
    }
}

/**
 * Reads a meeting's frames that have no OCR row yet (`tools meetings ocr`). Claims `ocr.pid` first: a second worker of
 * the same meeting returns `busy` and reads nothing. With `follow` it goes on while the recorder runs, woken by the
 * index's file events (a slow poll behind them), and ends once the recorder stopped and the backlog is read.
 */
export async function runOcrWorker(options: OcrWorkerOptions): Promise<OcrWorkerResult> {
    const worker = new OcrWorker(options);
    const pidPath = ocrPidPath(worker.folder);
    const claim = await claimPidFile(pidPath, {
        reclaimable: (state) => state.status === "dead" || state.status === "foreign",
    });

    if (claim.status !== "claimed") {
        const holder = claim.status === "held" && "pid" in claim.state ? claim.state.pid : undefined;
        log.info({ meeting: options.meetingId, holder }, "another OCR worker holds this meeting");
        return { ...worker.result, status: "busy", ...(holder !== undefined ? { holder } : {}) };
    }

    log.info(
        {
            meeting: options.meetingId,
            follow: options.follow ?? false,
            retryFailed: options.retryFailed ?? false,
            rereadEmptySince: options.rereadEmptySince?.toISOString(),
        },
        "OCR worker starts"
    );

    try {
        await worker.rewrite();
        worker.resume();
        const tail = new FrameIndexTail(worker.indexFile);

        if (!options.follow) {
            await worker.drain(tail);
        } else {
            if (!existsSync(worker.indexFile)) {
                // The watch needs the file; the recorder appends to it from its first frame.
                appendFileSync(worker.indexFile, "", { mode: CAPTURE_FILE_MODE });
            }

            await watchFileFeed({
                path: worker.indexFile,
                pollFallbackMs: options.pollMs ?? FOLLOW_POLL_MS,
                deadlineAt: Date.now() + FOLLOW_CEILING_MS,
                signal: options.signal,
                onChange: async () => {
                    // Read before the backlog: frames a recorder kept before it stopped are in the index by then.
                    const live = worker.recording();
                    await worker.drain(tail);
                    return { done: !live };
                },
            });
        }
    } finally {
        clearPidFile(pidPath);
    }

    log.info({ ...worker.result }, "OCR worker ends");
    return worker.result;
}

/** Starts a detached OCR worker that follows the meeting, unless one runs. */
export function startOcrWorker(store: MeetingStore, meetingId: string): number | undefined {
    if (ocrWorkerRunning(store.folder(meetingId))) {
        return undefined;
    }

    const pid = spawnToolDetached(["meetings", "ocr", meetingId, "--follow"]);
    log.info({ meeting: meetingId, pid }, "OCR worker started in the background");
    return pid;
}

/** What `ensureOcrWorkers` last saw of a meeting's two files, so an unchanged meeting is not read again. */
const backlogSeen = new Map<string, { signature: string; backlog: boolean }>();

function filesSignature(folder: string): string {
    return [frameIndexPath(folder), ocrPath(folder)]
        .map((path) => {
            if (!existsSync(path)) {
                return "-";
            }

            const stat = statSync(path);
            return `${stat.size}:${stat.mtimeMs}`;
        })
        .join("|");
}

/**
 * Starts an OCR worker for every recent meeting (started in the last two days) whose index lists frames without an
 * OCR row while no worker holds it: a worker that died, or a recorder whose start of it failed. The watcher calls it
 * on every tick; a meeting whose files did not change since its last look is not read again. Returns the meetings
 * it started a worker for.
 */
export async function ensureOcrWorkers(
    store: MeetingStore,
    options: { now?: Date; start?: (meetingId: string) => void } = {}
): Promise<string[]> {
    const now = options.now ?? new Date();
    const start = options.start ?? ((meetingId: string) => startOcrWorker(store, meetingId));
    const started: string[] = [];
    const { records } = store.listBounded({ since: new Date(now.getTime() - RECENT_DAYS * DAY_MS) });

    for (const record of records) {
        const folder = store.folder(record.id);

        if (!existsSync(frameIndexPath(folder)) || ocrWorkerRunning(folder)) {
            continue;
        }

        const signature = filesSignature(folder);
        const seen = backlogSeen.get(folder);
        let backlog = seen?.signature === signature ? seen.backlog : undefined;

        if (backlog === undefined) {
            backlog = ocrBacklog(folder).length > 0;
            backlogSeen.set(folder, { signature, backlog });
        }

        if (!backlog) {
            continue;
        }

        try {
            start(record.id);
            started.push(record.id);
        } catch (err) {
            log.warn({ err, meeting: record.id }, "the OCR worker could not be started");
        }
    }

    return started;
}

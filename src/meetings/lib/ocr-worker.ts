import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { abortableSleep } from "@genesiscz/utils/async";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { closeDarwinKit } from "@genesiscz/utils/macos/darwinkit";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import type { OcrResult } from "@genesiscz/utils/macos/types";
import type { CaptureFailureNotices, MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { claimPidFile, clearPidFile, inspectPidFile } from "@genesiscz/utils/process/pidfile";
import { type RecorderSettings, recorderSettingsSchema } from "@genesiscz/utils/screen-recorder/control";
import {
    CAPTURE_FILE_MODE,
    FrameReader,
    type ImageCropper,
    type OcrRecognizer,
    type OcrRow,
    type OcrRowFrame,
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
/** Rounds of reads a failed frame gets in all (its first and the worker's own retries) before it stays failed. */
export const OCR_MAX_ATTEMPTS = 3;
/** The waits on a frame while every read fails, also of a frame that read before: then every 5 minutes. */
export const OCR_OUTAGE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
/** Beside the meeting folders while OCR is down: the first worker that sees it says so, the one that sees it end too. */
const OCR_OUTAGE_FILE = "ocr-outage.json";
/** An outage stamp older than this is from a worker that died; the next outage says so again. */
const OCR_OUTAGE_STAMP_MS = 6 * 3_600_000;
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
    attempts: z.number().optional(),
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
        ...(stored.attempts !== undefined ? { attempts: stored.attempts } : {}),
    };
    return { line, row, file: row.file };
}

function readOcrLines(path: string, maxBytes?: number): OcrLine[] {
    if (!existsSync(path)) {
        return [];
    }

    const text = maxBytes === undefined ? undefined : readByteRange(path, 0, maxBytes);
    const lines = text === undefined ? readLinesSync(path) : text.split("\n");
    const out: OcrLine[] = [];

    for (const line of lines) {
        if (line.trim()) {
            out.push(parseOcrLine(line, path));
        }
    }

    return out;
}

/** The UTF-8 text of bytes `from` to `to` of a file (fewer when the file is shorter). */
function readByteRange(path: string, from: number, to: number): string {
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

/**
 * Ends a last line a crash cut short with a line end, under the worker's claim, before the worker appends: the next row
 * then starts on a line of its own and reads, instead of being glued onto the torn bytes. The torn line stays as it is;
 * readers skip it, and its frame has no row, so it is read again.
 */
function endTornTail(path: string): void {
    if (!existsSync(path)) {
        return;
    }

    const size = statSync(path).size;

    if (size === 0 || readByteRange(path, size - 1, size) === "\n") {
        return;
    }

    appendFileSync(path, "\n", { mode: CAPTURE_FILE_MODE });
    log.warn({ path }, "ocr.jsonl ended in a torn row; it gets a line end before the next row");
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
    /** Which notices an OCR outage posts (`capture.failureNotices`); default `failing-and-recovered`. */
    failureNotices?: CaptureFailureNotices;
    /** Default: a macOS notification in the meetings group. */
    notify?: (note: { title: string; message: string }) => Promise<void> | void;
    /** The wait between tries while OCR is down; default a timer that an abort ends. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
    /** Times every read failed, also of a frame that read before, so the worker waited for Vision. */
    outages: number;
}

type FrameOutcome =
    | { kind: "read"; row: OcrRow }
    | { kind: "bad"; row: OcrRow }
    | { kind: "failed"; row: OcrRow; error: string };

/** `down`: another frame failed too. `unverified`: there was no other frame to try, so nothing tells bad from down. */
type Probe = { kind: "next"; row: OcrRow } | { kind: "control" } | { kind: "down" } | { kind: "unverified" };

class OcrWorker {
    readonly folder: string;
    readonly ocrFile: string;
    readonly indexFile: string;
    readonly result: OcrWorkerResult;
    private readonly engine: OcrEngine;
    private readonly reader: FrameReader;
    private readonly done = new Set<string>();
    /** The failed rows and their rounds of reads so far: the ones under `OCR_MAX_ATTEMPTS` get another round. */
    private readonly failedAttempts = new Map<string, number>();
    /** A frame that read: the control that tells a bad frame from Vision being down. */
    private lastGood?: string;
    /** A read worked since the last round of failed rows. */
    private readSinceRetry = false;
    private outage?: { since: number };
    private readonly liveSettings: LiveOcrSettings;
    /** When the recording's last run began: its first frame gets the "almost no text" check. */
    private runStartMs = 0;
    /** The run's first frame has a row already (this worker's or an earlier one's). */
    private firstChecked = false;
    /** A row a crash cut short at the end of `ocr.jsonl` has a line end before this worker's first append. */
    private tailEnded = false;

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
        this.result = {
            meetingId: options.meetingId,
            status: "done",
            read: 0,
            reread: 0,
            failed: 0,
            restarts: 0,
            outages: 0,
        };
    }

    private frameOf(entry: FrameIndexRow): OcrRowFrame {
        return {
            file: entry.file,
            at: entry.at,
            displayId: entry.displayId,
            ...(entry.focusedDisplayId !== undefined ? { focusedDisplayId: entry.focusedDisplayId } : {}),
            changePercent: entry.changePercent,
            reason: entry.reason,
        };
    }

    /** A row for a frame no read could take: no text, the last error, and how many rounds of reads failed. */
    private failedRow(entry: FrameIndexRow, error: string, attempts: number): OcrRow {
        return { ...ocrRowOf(this.frameOf(entry), undefined, this.settings().minChars), failed: error, attempts };
    }

    /** One read of a frame through the reader: its row, or the error the read threw. */
    private async attemptOnce(entry: FrameIndexRow): Promise<{ row: OcrRow } | { error: unknown }> {
        const settings = this.settings();
        const path = join(this.folder, entry.file);

        try {
            const outcome = await this.reader.read({ frame: entry, path, displayId: entry.displayId, settings });
            this.noteRead(path);
            return { row: ocrRowOf(this.frameOf(entry), outcome, settings.minChars) };
        } catch (error) {
            log.warn({ err: error, meeting: this.options.meetingId, file: entry.file }, "an OCR read failed");
            return { error };
        }
    }

    private noteRead(path: string): void {
        this.lastGood = path;
        this.readSinceRetry = true;
    }

    /**
     * One frame's row. A read that throws is tried again; after `OCR_FAILURES_BEFORE_RESTART` in a row the helper is
     * thrown away and the fresh one tries as often. `failed` when it fails too: the caller decides whether the frame
     * is bad or Vision is down (`settle`). `bad` is a frame no read can take (its file is gone).
     */
    async readFrame(entry: FrameIndexRow, priorAttempts = 0): Promise<FrameOutcome> {
        const settings = this.settings();

        if (!settings.enabled) {
            return { kind: "read", row: ocrRowOf(this.frameOf(entry), undefined, settings.minChars) };
        }

        if (!existsSync(join(this.folder, entry.file))) {
            log.warn({ meeting: this.options.meetingId, file: entry.file }, "a frame in the index is not on disk");
            return { kind: "bad", row: this.failedRow(entry, "the frame file is missing", OCR_MAX_ATTEMPTS) };
        }

        let restarted = false;
        let failures = 0;

        for (;;) {
            const attempt = await this.attemptOnce(entry);

            if ("row" in attempt) {
                return { kind: "read", row: attempt.row };
            }

            failures += 1;

            if (failures < OCR_FAILURES_BEFORE_RESTART) {
                continue;
            }

            if (restarted) {
                const error = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
                return { kind: "failed", row: this.failedRow(entry, error, priorAttempts + 1), error };
            }

            this.restartEngine("the OCR helper failed in a row; a fresh one starts");
            restarted = true;
            failures = 0;
        }
    }

    private restartEngine(why: string): void {
        this.engine.restart();
        this.result.restarts += 1;
        log.warn({ meeting: this.options.meetingId }, why);
    }

    /**
     * Whether Vision reads at all now: a different frame right after the failed one. The next frame waiting (its row
     * is kept), else a frame that read before (only the read counts, its row stays). `down` when neither reads,
     * `unverified` when there was neither to try.
     */
    private async probe(next: FrameIndexRow | undefined): Promise<Probe> {
        if (next) {
            const attempt = await this.attemptOnce(next);

            if ("row" in attempt) {
                return { kind: "next", row: attempt.row };
            }
        }

        const control = this.lastGood && existsSync(this.lastGood) ? this.lastGood : undefined;

        if (!next && !control) {
            return { kind: "unverified" };
        }

        if (control) {
            const settings = this.settings();

            try {
                await this.engine.recognize(control, settings.languages, {
                    read: settings.read,
                    tilePx: settings.tilePx,
                });
                this.readSinceRetry = true;
                return { kind: "control" };
            } catch (error) {
                log.warn({ err: error, control }, "a frame that read before does not read now");
            }
        }

        return { kind: "down" };
    }

    /**
     * A frame whose reads all failed. When another frame reads right after it, the frame is bad: its row says
     * `failed` and the worker moves on. Else Vision is down on this Mac: the worker waits on the same frame (30 s,
     * 1 min, 2 min, then every 5 min) and tries it again, and says so once per outage. With no other frame to try
     * (a lone frame, nothing read before), nothing tells a bad frame from an outage: after `OCR_MAX_ATTEMPTS` waits
     * with still no other frame, it gets its failed row, which a later round or `--retry-failed` reads again.
     */
    private async settle(queue: FrameIndexRow[], failedRow: OcrRow, tail: FrameIndexTail): Promise<void> {
        const entry = queue[0];
        let verdict = await this.probe(queue[1]);
        let row = failedRow;
        let waited = 0;

        while (verdict.kind === "down" || (verdict.kind === "unverified" && waited < OCR_MAX_ATTEMPTS)) {
            await this.startOutage(row.failed ?? "every read failed");
            const wait = OCR_OUTAGE_BACKOFF_MS[Math.min(waited, OCR_OUTAGE_BACKOFF_MS.length - 1)];
            log.info({ meeting: this.options.meetingId, file: entry.file, waitMs: wait }, "OCR is down; waiting");
            await this.sleep(wait, this.options.signal);
            this.options.signal?.throwIfAborted();
            waited += 1;
            queue.push(...this.newEntries(tail, queue));
            const again = await this.attemptOnce(entry);

            if ("row" in again) {
                await this.endOutage();
                await this.writeRow(entry, again.row);
                queue.shift();
                return;
            }

            row = this.failedRow(entry, again.error instanceof Error ? again.error.message : String(again.error), 1);

            if (waited % OCR_FAILURES_BEFORE_RESTART === 0) {
                this.restartEngine("OCR is still down; a fresh helper starts");
            }

            verdict = await this.probe(queue[1]);
        }

        // An unverified end proves no recovery: the outage stays open until a read works.
        if (verdict.kind !== "unverified") {
            await this.endOutage();
        }

        log.error({ meeting: this.options.meetingId, file: entry.file, error: row.failed }, "a frame cannot be read");
        await this.writeRow(entry, row);
        queue.shift();

        if (verdict.kind === "next") {
            await this.writeRow(queue[0], verdict.row);
            queue.shift();
        }
    }

    /** The first failed frame of an outage: one notice for all workers (a stamp beside the meetings), as set. */
    private async startOutage(error: string): Promise<void> {
        if (this.outage) {
            return;
        }

        this.outage = { since: Date.now() };
        this.result.outages += 1;
        log.warn({ meeting: this.options.meetingId, error }, "OCR fails on this Mac; the frames wait");
        const stamp = join(this.options.store.root, OCR_OUTAGE_FILE);

        if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < OCR_OUTAGE_STAMP_MS) {
            return;
        }

        atomicWriteFileSync(stamp, SafeJSON.stringify({ since: new Date().toISOString(), error }), {
            mode: CAPTURE_FILE_MODE,
        });

        if (this.failureNotices() !== "off") {
            await this.notify({
                title: "Text reading (OCR) fails",
                message: "Text reading (OCR) fails on this Mac; frames are kept and are read when it works again.",
            });
        }
    }

    private async endOutage(): Promise<void> {
        if (!this.outage) {
            return;
        }

        log.info({ meeting: this.options.meetingId, downMs: Date.now() - this.outage.since }, "OCR works again");
        this.outage = undefined;
        const stamp = join(this.options.store.root, OCR_OUTAGE_FILE);

        try {
            unlinkSync(stamp);
        } catch (error) {
            // Another worker saw the recovery first and said so.
            log.debug({ error, stamp }, "the OCR outage stamp is gone already");
            return;
        }

        if (this.failureNotices() === "failing-and-recovered") {
            await this.notify({ title: "Text reading works again", message: "Text reading works again." });
        }
    }

    private failureNotices(): CaptureFailureNotices {
        return this.options.failureNotices ?? "failing-and-recovered";
    }

    private async notify(note: { title: string; message: string }): Promise<void> {
        const send =
            this.options.notify ??
            ((one: { title: string; message: string }) =>
                sendNotification({ ...one, group: "meetings", open: this.folder }));

        await Promise.resolve(send(note)).catch((err: unknown) =>
            log.warn({ err, meeting: this.options.meetingId }, "the OCR notice could not be posted")
        );
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (this.options.sleep) {
            return this.options.sleep(ms, signal);
        }

        return abortableSleep(ms, signal).catch((error: unknown) => {
            if (!signal?.aborted) {
                throw error;
            }
        });
    }

    /** The lines the recorder appended to the index since the last look that no row and no queued frame has. */
    private newEntries(tail: FrameIndexTail, queue: FrameIndexRow[]): FrameIndexRow[] {
        const queued = new Set(queue.map((entry) => entry.file));
        return tail.readNew().filter((entry) => !this.done.has(entry.file) && !queued.has(entry.file));
    }

    /** Appends a frame's row (the first frame of the run gets its text check) and counts it. */
    private async writeRow(entry: FrameIndexRow, row: OcrRow): Promise<void> {
        if (!this.firstChecked && Date.parse(entry.at) >= this.runStartMs) {
            this.firstChecked = true;
            await this.checkFirstFrame(row);
        }

        if (!this.tailEnded) {
            endTornTail(this.ocrFile);
            this.tailEnded = true;
        }

        appendFileSync(this.ocrFile, `${SafeJSON.stringify(row)}\n`, { mode: CAPTURE_FILE_MODE });
        this.done.add(entry.file);
        this.result.read += 1;

        if (row.failed !== undefined) {
            this.result.failed += 1;
            this.failedAttempts.set(row.file, row.attempts ?? 1);
        }
    }

    /**
     * Rewrites the chosen rows of `ocr.jsonl` in place: each is read again in file order (each display's earlier rows
     * stand for its previous read), and the file is replaced in one atomic write. Lines appended while it read are
     * kept after the rewritten ones. `auto` (the worker's own retry of failed rows) stops at the first failure while a
     * frame that read before does not read either: Vision is down, and that try does not count.
     */
    private async rewriteRows(target: (row: OcrRow) => boolean, auto: boolean): Promise<number> {
        if (!existsSync(this.ocrFile)) {
            return 0;
        }

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

            if (!target(row)) {
                if (row.failed === undefined) {
                    this.reader.seed(row.displayId, readOf(row));
                }

                continue;
            }

            this.options.signal?.throwIfAborted();
            const priorAttempts = row.failed === undefined ? 0 : (row.attempts ?? 1);
            const outcome = await this.readFrame(indexRowOf(row, motion.get(row.file)), priorAttempts);

            if (outcome.kind === "failed" && auto && (await this.probe(undefined)).kind !== "control") {
                log.warn({ meeting: this.options.meetingId, file: row.file }, "OCR is down; the failed rows wait");
                break;
            }

            lines[i] = { line: SafeJSON.stringify(outcome.row), row: outcome.row, file: outcome.row.file };
            changed += 1;

            if (outcome.row.failed === undefined) {
                this.failedAttempts.delete(row.file);
            } else {
                this.result.failed += 1;
                this.failedAttempts.set(row.file, outcome.row.attempts ?? priorAttempts + 1);
            }
        }

        if (changed === 0) {
            return 0;
        }

        const appended = readByteRange(this.ocrFile, size, statSync(this.ocrFile).size);
        const body = `${lines.map((one) => one.line).join("\n")}\n${appended}`;
        atomicWriteFileSync(this.ocrFile, body, { mode: CAPTURE_FILE_MODE });
        this.result.reread += changed;
        log.info({ meeting: this.options.meetingId, changed, auto }, "ocr.jsonl rows read again");
        return changed;
    }

    /**
     * `--retry-failed` and `--reread-empty-since`: every failed row, and every row with no text from that time on.
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
        const changed = await this.rewriteRows(
            (row) =>
                (retryFailed === true && row.failed !== undefined) ||
                (sinceMs !== undefined && row.text.trim() === "" && Date.parse(row.at) >= sinceMs),
            false
        );

        if (changed === 0) {
            log.info({ meeting: this.options.meetingId }, "no ocr.jsonl row to read again");
        }
    }

    /**
     * Failed rows are read again by themselves once reads work: after a drain in which a frame read, every failed row
     * with fewer than `OCR_MAX_ATTEMPTS` rounds gets one more.
     */
    private async retryFailedRows(): Promise<void> {
        const due = [...this.failedAttempts.values()].some((attempts) => attempts < OCR_MAX_ATTEMPTS);

        if (!due) {
            return;
        }

        // A run that read no new frame (an ended meeting, started only for its failed rows) checks that reads work on
        // a frame that read before, and retries only then.
        if (!this.readSinceRetry && (await this.probe(undefined)).kind !== "control") {
            return;
        }

        if (this.recording() && !existsSync(this.indexFile)) {
            return;
        }

        this.readSinceRetry = false;
        await this.rewriteRows((row) => row.failed !== undefined && (row.attempts ?? 1) < OCR_MAX_ATTEMPTS, true);
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

            if (row.failed !== undefined) {
                this.failedAttempts.set(row.file, row.attempts ?? 1);
            } else if (row.text.trim()) {
                this.lastGood = join(this.folder, row.file);
            }

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

    /**
     * Reads every indexed frame that has no row yet, in index order, appending one row each; a failed frame is settled
     * first (`settle`), and the failed rows get their next round when reads work.
     */
    async drain(tail: FrameIndexTail): Promise<void> {
        const queue = this.newEntries(tail, []);

        while (queue.length > 0) {
            this.options.signal?.throwIfAborted();
            const entry = queue[0];
            const outcome = await this.readFrame(entry);

            if (outcome.kind === "failed") {
                await this.settle(queue, outcome.row, tail);
            } else {
                await this.writeRow(entry, outcome.row);
                queue.shift();
            }

            if (queue.length === 0) {
                queue.push(...this.newEntries(tail, queue));
            }
        }

        await this.retryFailedRows();
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
const backlogSeen = new Map<string, { signature: string; backlog: boolean; retryDue: boolean }>();
/** When a worker last started only to retry a meeting's failed rows: at most one such start per `RETRY_START_GAP_MS`. */
const retryStartedAt = new Map<string, number>();
/** The least time between two workers started only for failed rows, so an outage does not start one every tick. */
export const RETRY_START_GAP_MS = 10 * 60_000;

/** Whether `ocr.jsonl` holds a failed row with rounds left (`OCR_MAX_ATTEMPTS`). */
function failedRowsDue(folder: string): boolean {
    return readOcrLines(ocrPath(folder)).some(
        ({ row }) => row?.failed !== undefined && (row.attempts ?? 1) < OCR_MAX_ATTEMPTS
    );
}

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

        if ((!existsSync(frameIndexPath(folder)) && !existsSync(ocrPath(folder))) || ocrWorkerRunning(folder)) {
            continue;
        }

        const signature = filesSignature(folder);
        let seen = backlogSeen.get(folder);

        if (seen?.signature !== signature) {
            seen = {
                signature,
                backlog: existsSync(frameIndexPath(folder)) && ocrBacklog(folder).length > 0,
                retryDue: failedRowsDue(folder),
            };
            backlogSeen.set(folder, seen);
        }

        // Failed rows with rounds left start a worker too (an ended meeting reads no new frame), at most every
        // RETRY_START_GAP_MS, so a Vision outage does not start one on every tick.
        const retryOnly =
            !seen.backlog && seen.retryDue && now.getTime() - (retryStartedAt.get(folder) ?? 0) >= RETRY_START_GAP_MS;

        if (!seen.backlog && !retryOnly) {
            continue;
        }

        if (retryOnly) {
            retryStartedAt.set(folder, now.getTime());
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

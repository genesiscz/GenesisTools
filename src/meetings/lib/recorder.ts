import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import {
    attemptStaleTakeover,
    classifyPidRecord,
    clearPidFile,
    inspectPidFile,
    parsePidRecord,
    writePidFile,
} from "@genesiscz/utils/process/pidfile";
import { atomicWriteFileSync, readFileIfExistsSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { meetingSource } from "./sources";

const { log } = logger.scoped("meetings-recorder");

/** Peekaboo's live capture runs at most 180 s; shorter pieces also make a stop take effect sooner. */
const CHUNK_MS = 30_000;
/** Consecutive failed pieces after which the recorder gives up. */
const MAX_FAILURES = 3;
/** The first frame's OCR finds less text than this: probably only the desktop, so the grant is likely missing. */
const EMPTY_FRAME_CHARS = 20;
const OCR_LANGUAGES = ["cs-CZ", "en-US"];

/** Where the one running recording keeps its pid, its state and its stop request. */
export function recorderFiles(store: MeetingStore): { pid: string; state: string; stop: string } {
    return {
        pid: join(store.root, "recorder.pid"),
        state: join(store.root, "recorder.json"),
        stop: join(store.root, "recorder.stop"),
    };
}

const recorderStateSchema = z.object({
    meetingId: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    display: z.number(),
    frames: z.number(),
    bytes: z.number(),
    lastFrameAt: z.string().optional(),
    warning: z.string().optional(),
});
export type RecorderState = z.infer<typeof recorderStateSchema>;

export function readRecorderState(store: MeetingStore): { running: boolean; state?: RecorderState } {
    const files = recorderFiles(store);
    const running = inspectPidFile(files.pid).status === "live";
    const parsed = existsSync(files.state)
        ? recorderStateSchema.safeParse(SafeJSON.parse(readFileSync(files.state, "utf8")))
        : undefined;
    return { running, ...(parsed?.success ? { state: parsed.data } : {}) };
}

const liveOutput = z.object({
    success: z.boolean(),
    data: z.object({ frames: z.array(z.object({ timestampMs: z.number(), path: z.string() })).default([]) }).optional(),
});

function pad(n: number, width = 2): string {
    return String(n).padStart(width, "0");
}

/** `15-23-41-502.jpg`: the frame's local wall time, sortable within a day. */
function frameName(at: Date): string {
    return `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}.jpg`;
}

async function run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stdout, stderr };
}

/** One piece of change-aware screen capture: frames only when the screen changed, PNG files in `dir`. */
async function capturePiece(options: {
    dir: string;
    display: number;
    capture: MeetingsConfig["global"]["capture"];
}): Promise<{ startedAt: number; frames: Array<{ timestampMs: number; path: string }> }> {
    const { capture } = options;
    const argv = [
        "peekaboo",
        "capture",
        "live",
        "--mode",
        "screen",
        "--screen-index",
        String(options.display),
        "--duration",
        String(CHUNK_MS),
        "--active-fps",
        String(Math.max(0.5, capture.activeFps)),
        "--idle-fps",
        String(Math.max(0.1, Math.min(capture.idleFps, capture.activeFps))),
        "--threshold",
        String(capture.threshold * 100),
        "--resolution-cap",
        String(capture.resolutionCap),
        "--path",
        options.dir,
        "--json",
        "--no-remote",
    ];
    const startedAt = Date.now();
    const result = await run(argv);
    log.debug({ exitCode: result.exitCode, dir: options.dir }, "capture piece");

    if (result.exitCode !== 0) {
        throw new Error(`peekaboo exited ${result.exitCode}: ${result.stderr.trim().slice(-300)}`);
    }

    const parsed = liveOutput.parse(SafeJSON.parse(result.stdout));
    return { startedAt, frames: parsed.data?.frames ?? [] };
}

/** PNG to a reduced JPEG with the system's own `sips`. */
async function toJpeg(png: string, jpg: string, quality: number): Promise<void> {
    const result = await run([
        "sips",
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.round(quality * 100)),
        png,
        "--out",
        jpg,
    ]);

    if (result.exitCode !== 0) {
        throw new Error(`sips failed for ${png}: ${result.stderr.trim()}`);
    }
}

/** Removes what is left in a piece's folder: the capture tool's own PNGs and metadata, all made by this recording. */
function emptyPieceFolder(dir: string): void {
    for (const name of readdirSync(dir)) {
        unlinkSync(join(dir, name));
    }
}

/**
 * The recorder process (`tools meetings record run`): captures the screen in pieces until `record stop` asks it to end,
 * converts each new frame to JPEG under the meeting's `frames/`, runs Vision OCR on it into `ocr.jsonl`, and writes the
 * meeting's `recording` block at the end.
 */
export async function runRecorder(options: {
    store: MeetingStore;
    meetingId: string;
    display: number;
    capture: MeetingsConfig["global"]["capture"];
}): Promise<RecorderState> {
    const { store, meetingId, capture } = options;
    const files = recorderFiles(store);
    const folder = store.folder(meetingId);
    const framesDir = join(folder, "frames");
    const pieceDir = join(folder, ".piece");
    const ocrPath = join(folder, "ocr.jsonl");

    const previous = readFileIfExistsSync(files.pid);
    const content = previous ? Buffer.from(previous).toString("utf8") : undefined;
    const owner = content ? parsePidRecord(content) : null;
    const status = owner ? classifyPidRecord(owner).status : undefined;
    const reclaimed =
        content && (status === "dead" || status === "foreign") ? await attemptStaleTakeover(files.pid, content) : false;

    if (!reclaimed) {
        writePidFile(files.pid, { exclusive: true });
    }

    try {
        mkdirSync(framesDir, { recursive: true });
        mkdirSync(pieceDir, { recursive: true });

        if (existsSync(files.stop)) {
            unlinkSync(files.stop);
        }

        const state: RecorderState = {
            meetingId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            display: options.display,
            frames: 0,
            bytes: 0,
        };
        const saveState = () => atomicWriteFileSync(files.state, SafeJSON.stringify(state, null, 2));
        saveState();
        await store.update(meetingId, { command: "record start", change: `display ${options.display}` }, (record) => {
            record.recording = {
                startedAt: state.startedAt,
                display: options.display,
                framesDir: "frames",
                ocr: "ocr.jsonl",
                status: "recording",
            };
        });

        let failures = 0;
        let stopRequested = false;
        const onSignal = () => {
            stopRequested = true;
        };
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);

        try {
            while (!stopRequested && !existsSync(files.stop)) {
                let piece: Awaited<ReturnType<typeof capturePiece>>;

                try {
                    piece = await capturePiece({ dir: pieceDir, display: options.display, capture });
                    failures = 0;
                } catch (err) {
                    failures += 1;
                    log.warn({ err, failures }, "capture piece failed");

                    if (failures >= MAX_FAILURES) {
                        state.warning = `capture failed ${failures} times in a row: ${err instanceof Error ? err.message : String(err)}`;
                        throw new Error(state.warning, { cause: err });
                    }

                    await Bun.sleep(5_000);
                    continue;
                }

                for (const frame of piece.frames) {
                    const at = new Date(piece.startedAt + frame.timestampMs);
                    const name = frameName(at);
                    const jpg = join(framesDir, name);
                    await toJpeg(frame.path, jpg, capture.jpegQuality);
                    const ocr = await recognizeText(jpg, { languages: OCR_LANGUAGES }).catch((err: unknown) => {
                        log.warn({ err, jpg }, "OCR failed for a frame");
                        return { text: "", blocks: [] };
                    });

                    if (state.frames === 0 && ocr.text.trim().length < EMPTY_FRAME_CHARS) {
                        state.warning = `The first frame holds almost no readable text: Screen Recording may be missing (macOS then returns only the desktop; check ${toolCommand("control", "doctor")}), or the text is too small for capture.resolutionCap.`;
                    }

                    appendFileSync(
                        ocrPath,
                        `${SafeJSON.stringify({
                            file: `frames/${name}`,
                            at: at.toISOString(),
                            text: ocr.text,
                            blocks: ocr.blocks.map((block) => ({
                                text: block.text,
                                confidence: block.confidence,
                                bounds: block.bounds,
                            })),
                        })}\n`
                    );
                    state.frames += 1;
                    state.bytes += statSync(jpg).size;
                    state.lastFrameAt = at.toISOString();
                }

                emptyPieceFolder(pieceDir);
                saveState();
            }
        } finally {
            process.off("SIGTERM", onSignal);
            process.off("SIGINT", onSignal);
            emptyPieceFolder(pieceDir);
            rmdirSync(pieceDir);
        }

        const stoppedAt = new Date().toISOString();
        const record = store.read(meetingId);
        const linked = Object.entries(record?.sources ?? {}).find(([, block]) => typeof block.meetingId === "string");
        let clock: { source: string; startedAt: string } | undefined;

        if (linked && typeof linked[1].meetingId === "string") {
            const source = await meetingSource(linked[0]);
            const sourceClock = await source.recordingClock(linked[1].meetingId).catch((err: unknown) => {
                log.warn({ err }, "recording clock unavailable");
                return null;
            });
            clock = sourceClock ? { source: source.id, startedAt: sourceClock.startedAt } : undefined;
        }

        await store.update(
            meetingId,
            { command: "record stop", change: `${state.frames} frames, ${Math.round(state.bytes / 1_000_000)} MB` },
            (current) => {
                current.recording = {
                    ...current.recording,
                    startedAt: state.startedAt,
                    stoppedAt,
                    frames: state.frames,
                    bytes: state.bytes,
                    status: "stopped",
                    ...(clock ? { clock } : {}),
                    ...(state.warning ? { warning: state.warning } : {}),
                };
            }
        );

        if (existsSync(files.stop)) {
            unlinkSync(files.stop);
        }

        renameSync(files.state, join(folder, "recorder-last.json"));
        log.info({ meetingId, frames: state.frames, bytes: state.bytes }, "recording stopped");
        return state;
    } catch (err) {
        const warning = err instanceof Error ? err.message : String(err);
        const state = readRecorderState(store).state;
        await store.update(meetingId, { command: "record stop", change: `failed: ${warning}` }, (current) => {
            current.recording = {
                ...current.recording,
                status: "failed",
                stoppedAt: new Date().toISOString(),
                frames: state?.frames ?? 0,
                bytes: state?.bytes ?? 0,
                warning,
            };
        });
        if (existsSync(files.state)) {
            renameSync(files.state, join(folder, "recorder-last.json"));
        }
        throw err;
    } finally {
        clearPidFile(files.pid);
    }
}

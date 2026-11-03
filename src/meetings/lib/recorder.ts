import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { join } from "node:path";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { abortableSleep } from "@genesiscz/utils/async";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import { type DisplayPolicy, displayPolicySchema, type MeetingsConfig } from "@genesiscz/utils/meetings/config";
import {
    type MeetingStore,
    RECORDING_STOP_REASONS,
    type RecordingBlock,
    type RecordingSpan,
    type RecordingStopReason,
} from "@genesiscz/utils/meetings/record";
import { clearPidFile, inspectPidFile, writePidFile } from "@genesiscz/utils/process/pidfile";
import { mainDisplay } from "@genesiscz/utils/screen-recorder/displays";
import { LiveRecordingServer, liveRecordingId, RPC_ERRORS, RpcError } from "@genesiscz/utils/screen-recorder/live";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import {
    CaptureError,
    type CaptureResult,
    type CaptureTarget,
    type DisplayInfo,
    type FrameRecorder,
} from "@genesiscz/utils/screen-recorder/types";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import { meetingSource } from "./sources";
import { RETRY_AFTER_MS, readAuto } from "./watch-auto";

const { log } = logger.scoped("meetings-recorder");

/** One capture runs at most 180 s; shorter pieces also re-read the displays sooner. */
const CHUNK_SEC = 30;
/** Consecutive pieces in which every capture failed, after which the recorder gives up. */
const MAX_FAILURES = 3;
const FAILURE_PAUSE_MS = 5_000;
/** The first frame's OCR finds less text than this: probably only the desktop, so the grant is likely missing. */
const EMPTY_FRAME_CHARS = 20;
const OCR_LANGUAGES = ["cs-CZ", "en-US"];

/** Where the one running recording keeps its pid and its state. */
export function recorderFiles(store: MeetingStore): { pid: string; state: string } {
    return { pid: join(store.root, "recorder.pid"), state: join(store.root, "recorder.json") };
}

/** The live recording of a meeting's recorder, whose socket `record pause|resume|stop|display` and the menu bar call. */
export function meetingLiveId(meetingId: string): string {
    return liveRecordingId("meeting", meetingId);
}

const recorderStateSchema = z.object({
    meetingId: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    /** The display policy (an index for a recorder from before the policies). */
    display: displayPolicySchema,
    backend: z.string().optional(),
    displays: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
    paused: z.boolean().optional(),
    frames: z.number(),
    bytes: z.number(),
    lastFrameAt: z.string().optional(),
    warning: z.string().optional(),
    stopReason: z.enum(RECORDING_STOP_REASONS).optional(),
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

function pad(n: number, width = 2): string {
    return String(n).padStart(width, "0");
}

/** `15-23-41-502-d4.jpg`: the frame's local wall time, sortable within a day, and its display. */
export function frameName(at: Date, displayId: number): string {
    return `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}-d${displayId}.jpg`;
}

async function run(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
}

/** PNG to a reduced JPEG with the system's own `sips`. */
async function sipsJpeg(png: string, jpg: string, quality: number): Promise<void> {
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

/** The frames a recording holds on disk, their size, and the count per display (from the `-d<id>` of the name). */
export function framesOnDisk(framesDir: string): { frames: number; bytes: number; perDisplay: Map<number, number> } {
    const files = readdirSync(framesDir).filter((name) => name.endsWith(".jpg"));
    const perDisplay = new Map<number, number>();

    for (const name of files) {
        const id = name.match(/-d(\d+)\.jpg$/)?.[1];

        if (id) {
            perDisplay.set(Number(id), (perDisplay.get(Number(id)) ?? 0) + 1);
        }
    }

    return {
        frames: files.length,
        bytes: files.reduce((sum, name) => sum + statSync(join(framesDir, name)).size, 0),
        perDisplay,
    };
}

/** A capture that runs this piece: what it records, and the display its frames belong to when the frame says none. */
interface PieceTarget {
    target: CaptureTarget;
    displayId: number;
    label: string;
}

/**
 * What to record right now: the displays chosen over the socket (`displays.add|remove|switch`) when there are any,
 * else the policy. `fallback` says why the main display stands in for the asked one.
 */
export function pieceTargets(options: {
    policy: DisplayPolicy;
    displays: DisplayInfo[];
    followFocus: boolean;
    chosen?: number[];
}): {
    targets: PieceTarget[];
    fallback?: string;
} {
    const { policy, displays } = options;
    const main = mainDisplay(displays);
    const one = (display: DisplayInfo): PieceTarget => ({
        target: { kind: "display", displayId: display.id },
        displayId: display.id,
        label: `${display.name} (${display.id})`,
    });

    if (!main) {
        return { targets: [] };
    }

    if (options.chosen) {
        const chosen = displays.filter((display) => options.chosen?.includes(display.id));
        return chosen.length > 0
            ? { targets: chosen.map(one) }
            : {
                  targets: [one(main)],
                  fallback: `displays ${options.chosen.join(", ")} were not connected; the main display was recorded while they were missing`,
              };
    }

    if (policy === "all") {
        return { targets: displays.map(one) };
    }

    if (policy === "main") {
        return { targets: [one(main)] };
    }

    if (policy === "follow-focus") {
        return options.followFocus
            ? { targets: [{ target: { kind: "follow-focus" }, displayId: main.id, label: "the focused display" }] }
            : {
                  targets: [one(main)],
                  fallback: "this recorder cannot follow the focused display; the main display was recorded",
              };
    }

    const asked = displays.find((display) => display.index === policy);
    return asked
        ? { targets: [one(asked)] }
        : {
              targets: [one(main)],
              fallback: `display ${policy} was not connected; the main display was recorded while it was missing`,
          };
}

export interface RecorderNote {
    title: string;
    message: string;
    open?: string;
}

/** What the recorder uses beside the store, so a test can replace each part. */
export interface RecorderDeps {
    recorder: FrameRecorder;
    toJpeg: (png: string, jpg: string, quality: number) => Promise<void>;
    ocr: (
        jpg: string
    ) => Promise<{ text: string; blocks: Array<{ text: string; confidence: number; bounds: unknown }> }>;
    notify: (note: RecorderNote) => Promise<void>;
    /** Where the live recording entry goes (the genesis-tools root's `recordings/live/` by default). */
    liveDir?: string;
    pieceSec: number;
    failurePauseMs: number;
}

function defaultDeps(capture: MeetingsConfig["global"]["capture"]): RecorderDeps {
    return {
        recorder: FRAME_RECORDERS[capture.backend]({ axToolBinary: ensureBinaryAsync }),
        toJpeg: sipsJpeg,
        ocr: (jpg) => recognizeText(jpg, { languages: OCR_LANGUAGES }),
        notify: async (note) => {
            await sendNotification({ ...note, group: "meetings" }).catch((err: unknown) =>
                log.warn({ err }, "notification failed")
            );
        },
        pieceSec: CHUNK_SEC,
        failurePauseMs: FAILURE_PAUSE_MS,
    };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The recorder process (`tools meetings record run`): captures the screen in pieces until a stop (a live recording
 * command, `record stop`, or a signal), converts each new frame to JPEG under the meeting's `frames/`, runs Vision
 * OCR on it into `ocr.jsonl`, and keeps the meeting's `recording` block. Pause and resume end and start a span.
 */
export async function runRecorder(options: {
    store: MeetingStore;
    meetingId: string;
    capture: MeetingsConfig["global"]["capture"];
    /** Overrides `capture.displays`. */
    display?: DisplayPolicy;
    deps?: Partial<RecorderDeps>;
}): Promise<RecorderState> {
    const { store, meetingId, capture } = options;
    const deps: RecorderDeps = { ...defaultDeps(capture), ...options.deps };
    let policy = options.display ?? capture.displays;
    let chosen: number[] | undefined;
    const files = recorderFiles(store);
    const folder = store.folder(meetingId);
    const framesDir = join(folder, "frames");
    const pieceDir = join(folder, ".piece");
    const ocrPath = join(folder, "ocr.jsonl");
    const record = store.read(meetingId);

    writePidFile(files.pid, { exclusive: true });

    const state: RecorderState = {
        meetingId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        display: policy,
        backend: deps.recorder.id,
        frames: 0,
        bytes: 0,
    };
    const notes: string[] = [];
    const note = (text: string) => {
        if (!notes.includes(text)) {
            notes.push(text);
        }
    };
    const seenDisplays = new Map<number, string>(
        (record?.recording?.displays ?? []).map((display) => [display.id, display.name])
    );
    const spans: RecordingSpan[] = [...(record?.recording?.spans ?? [])];
    let paused = false;
    let stopRequested = false;
    let piece: AbortController | undefined;
    let wake: (() => void) | undefined;
    const stopping = new AbortController();
    const saveState = () => atomicWriteFileSync(files.state, SafeJSON.stringify(state, null, 2));
    const connected = async (displayId: number): Promise<DisplayInfo> => {
        const display = (await deps.recorder.displays()).find((one) => one.id === displayId);

        if (!display) {
            throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not connected`);
        }

        return display;
    };
    const displayIdOf = (params: unknown): number => {
        const parsed = z.object({ displayId: z.number().int() }).safeParse(params);

        if (!parsed.success) {
            throw new RpcError(RPC_ERRORS.invalidParams, "give { displayId: <number> }");
        }

        return parsed.data.displayId;
    };
    /** A change of displays applies now: the running piece ends and the next one starts with the new set. */
    const reselect = (change: () => void) => {
        if (stopRequested) {
            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
        }

        change();
        log.info({ policy, chosen }, "recorded displays chosen over the socket");
        piece?.abort();
        return { mode: policy, chosen: chosen ?? null };
    };
    const live = new LiveRecordingServer({
        id: meetingLiveId(meetingId),
        kind: "meeting",
        title: record?.title || meetingId,
        folder,
        dir: deps.liveDir,
        methods: {
            stop: () => {
                if (stopRequested) {
                    throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is already stopping");
                }

                requestStop();
                return { state: "stopping" };
            },
            pause: () => {
                if (stopRequested) {
                    throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
                }

                if (paused) {
                    throw new RpcError(RPC_ERRORS.alreadyPaused, "the recording is already paused");
                }

                paused = true;
                piece?.abort();
                live.update({ state: "paused" });
                return { state: "paused" };
            },
            resume: () => {
                if (!paused || stopRequested) {
                    throw new RpcError(RPC_ERRORS.notPaused, "the recording is not paused");
                }

                paused = false;
                wake?.();
                live.update({ state: "recording" });
                return { state: "recording" };
            },
            "displays.list": async () => {
                const recordedIds = new Set(state.displays?.map((display) => display.id) ?? []);
                return (await deps.recorder.displays()).map((display) => ({
                    ...display,
                    recorded: recordedIds.has(display.id),
                }));
            },
            "displays.add": async (params) => {
                const display = await connected(displayIdOf(params));
                const current = state.displays?.map((one) => one.id) ?? [];
                return reselect(() => {
                    chosen = [...new Set([...(chosen ?? current), display.id])];
                });
            },
            "displays.remove": async (params) => {
                const displayId = displayIdOf(params);
                const current = chosen ?? state.displays?.map((one) => one.id) ?? [];

                if (!current.includes(displayId)) {
                    throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not being recorded`);
                }

                if (current.length === 1) {
                    throw new RpcError(
                        RPC_ERRORS.lastDisplay,
                        "the last recorded display cannot be removed; pause or stop instead"
                    );
                }

                return reselect(() => {
                    chosen = current.filter((id) => id !== displayId);
                });
            },
            "displays.switch": async (params) => {
                const display = await connected(displayIdOf(params));
                return reselect(() => {
                    chosen = [display.id];
                });
            },
            "displays.mode": (params) => {
                const parsed = z.object({ mode: displayPolicySchema }).safeParse(params);

                if (!parsed.success) {
                    throw new RpcError(RPC_ERRORS.invalidParams, "give { mode: all | follow-focus | main | <index> }");
                }

                return reselect(() => {
                    policy = parsed.data.mode;
                    chosen = undefined;
                    state.display = policy;
                });
            },
        },
    });
    const requestStop = () => {
        stopRequested = true;
        live.update({ state: "stopping" });
        piece?.abort();
        stopping.abort();
        wake?.();
    };
    const onSignal = () => requestStop();
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    const updateRecording = (change: string, mutate: (recording: RecordingBlock) => void) =>
        store.update(meetingId, { command: "record", change }, (current) => {
            const recording: RecordingBlock = { ...current.recording };
            mutate(recording);
            current.recording = recording;
        });
    const openSpan = () => spans.push({ from: new Date().toISOString() });
    const closeSpan = (stopReason: RecordingStopReason) => {
        const open = spans.at(-1);

        if (open && !open.to) {
            open.to = new Date().toISOString();
            open.stopReason = stopReason;
        }
    };

    let failures = 0;
    let failureNoticeOpen = Boolean(record?.recording?.failureNotifiedAt);
    let runFrames = 0;
    let lastDisplayIds = "";
    let lastConnected = "";

    const keepFrames = async (result: CaptureResult, target: PieceTarget): Promise<void> => {
        for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
            const at = new Date(result.startedAtMs + frame.atMs);
            const displayId = frame.displayId ?? target.displayId;
            const name = frameName(at, displayId);
            const jpg = join(framesDir, name);
            await deps.toJpeg(frame.path, jpg, capture.jpegQuality);
            const ocr = await deps.ocr(jpg).catch((err: unknown) => {
                log.warn({ err, jpg }, "OCR failed for a frame");
                return { text: "", blocks: [] };
            });

            if (state.frames === 0 && ocr.text.trim().length < EMPTY_FRAME_CHARS) {
                note(
                    `The first frame holds almost no readable text: Screen Recording may be missing (macOS then returns only the desktop; check ${toolCommand("control", "doctor")}), or the text is too small for capture.resolutionCap.`
                );
            }

            appendFileSync(
                ocrPath,
                `${SafeJSON.stringify({
                    file: `frames/${name}`,
                    at: at.toISOString(),
                    displayId,
                    text: ocr.text,
                    blocks: ocr.blocks.map((block) => ({
                        text: block.text,
                        confidence: block.confidence,
                        bounds: block.bounds,
                    })),
                })}\n`
            );
            state.frames += 1;
            runFrames += 1;
            state.bytes += statSync(jpg).size;
            state.lastFrameAt = at.toISOString();
            live.emit("frame", { displayId, at: at.toISOString(), file: jpg });
        }
    };

    /** One piece: every target at once. False when every capture failed. */
    const capturePiece = async (): Promise<boolean> => {
        const displays = await deps.recorder.displays();
        const { targets, fallback } = pieceTargets({
            policy,
            displays,
            followFocus: deps.recorder.supports.followFocus,
            chosen,
        });
        const connectedIds = displays.map((display) => display.id).join(",");

        if (connectedIds !== lastConnected) {
            const before = new Set(lastConnected.split(",").filter(Boolean).map(Number));
            const now = new Set(displays.map((display) => display.id));
            live.emit("displays", {
                connected: displays.map((display) => ({ id: display.id, name: display.name })),
                removed: [...before].filter((id) => !now.has(id)),
            });
            lastConnected = connectedIds;
        }

        if (fallback) {
            note(`${fallback} (since ${localTime(new Date().toISOString())})`);
        }

        for (const display of displays) {
            seenDisplays.set(display.id, display.name);
        }

        const ids = targets.map((target) => target.displayId).join(",");

        if (ids !== lastDisplayIds) {
            log.info({ from: lastDisplayIds, to: ids }, "recorded displays changed");
            lastDisplayIds = ids;
            state.displays = targets.map((target) => ({
                id: target.displayId,
                name: seenDisplays.get(target.displayId) ?? target.label,
            }));
            live.update({ displays: state.displays });
        }

        if (targets.length === 0) {
            throw new CaptureError("display-missing", "no display is connected");
        }

        piece = new AbortController();
        const signal = piece.signal;
        const settled = await Promise.allSettled(
            targets.map(async (target) => {
                const outDir = join(pieceDir, `d${target.displayId}`);
                mkdirSync(outDir, { recursive: true });
                return deps.recorder.capture(
                    {
                        target: target.target,
                        durationSec: deps.pieceSec,
                        activeFps: capture.activeFps,
                        idleFps: capture.idleFps,
                        thresholdPercent: capture.threshold * 100,
                        maxLongSidePx: capture.resolutionCap,
                        outDir,
                    },
                    signal
                );
            })
        );
        let recorded = false;
        let lastError: unknown;

        for (const [index, outcome] of settled.entries()) {
            const target = targets[index]!;

            if (outcome.status === "fulfilled") {
                recorded = true;
                await keepFrames(outcome.value, target);

                if (outcome.value.endedEarly === "display-removed") {
                    log.info({ display: target.label }, "a display left during a piece");
                }

                continue;
            }

            lastError = outcome.reason;

            if (outcome.reason instanceof CaptureError && outcome.reason.kind === "display-missing") {
                log.info({ display: target.label }, "a display left before its capture");
                continue;
            }

            log.warn({ err: outcome.reason, display: target.label }, "a capture failed");

            if (targets.length > 1) {
                note(`${target.label}: ${errorText(outcome.reason)}`);
            }
        }

        rmSync(pieceDir, { recursive: true, force: true });
        mkdirSync(pieceDir, { recursive: true });

        if (!recorded && !signal.aborted) {
            throw lastError ?? new CaptureError("failed", "no capture ran");
        }

        return recorded;
    };

    try {
        mkdirSync(framesDir, { recursive: true });
        rmSync(pieceDir, { recursive: true, force: true });
        mkdirSync(pieceDir, { recursive: true });
        saveState();
        openSpan();
        await store.update(
            meetingId,
            { command: "record start", change: `display ${policy} (${deps.recorder.id})` },
            (current) => {
                current.recording = {
                    ...current.recording,
                    startedAt: state.startedAt,
                    backend: deps.recorder.id,
                    displayPolicy: policy,
                    framesDir: "frames",
                    ocr: "ocr.jsonl",
                    status: "recording",
                    spans,
                };
                delete current.recording.stoppedAt;
                delete current.recording.stopReason;
            }
        );
        const ready = await deps.recorder.available();

        if (!ready.ok) {
            throw new CaptureError("unavailable", `the ${deps.recorder.id} recorder is not available: ${ready.reason}`);
        }

        while (!stopRequested) {
            if (paused) {
                closeSpan("paused");
                state.paused = true;
                saveState();
                await updateRecording("paused", (recording) => {
                    recording.status = "paused";
                    recording.spans = spans;
                });
                await new Promise<void>((resolve) => {
                    wake = resolve;

                    if (!paused || stopRequested) {
                        resolve();
                    }
                });
                wake = undefined;

                if (stopRequested) {
                    break;
                }

                openSpan();
                state.paused = false;
                await updateRecording("resumed", (recording) => {
                    recording.status = "recording";
                    recording.spans = spans;
                });
            }

            try {
                const recorded = await capturePiece();

                if (recorded) {
                    failures = 0;
                }

                if (recorded && failureNoticeOpen) {
                    failureNoticeOpen = false;
                    await updateRecording("capture works again", (recording) => {
                        delete recording.failureNotifiedAt;
                    });
                }
            } catch (err) {
                // Only a capture fails a piece; anything else (a frame that cannot be converted) ends the recording.
                if (!(err instanceof CaptureError)) {
                    throw err;
                }

                failures += 1;
                log.warn({ err, failures }, "capture piece failed");

                if (failures >= MAX_FAILURES) {
                    note(`capture failed ${failures} times in a row: ${errorText(err)}`);
                    state.stopReason = "failed";
                    break;
                }

                await abortableSleep(deps.failurePauseMs, stopping.signal).catch(() => undefined);
            }

            state.warning = notes.length > 0 ? notes.join("; ") : undefined;
            live.update({ frames: state.frames, lastFrameAt: state.lastFrameAt, warning: state.warning });
            saveState();
        }
    } catch (err) {
        log.error({ err, meetingId }, "the recorder stopped on an error");
        note(`the recorder stopped on an error: ${errorText(err)}`);
        state.stopReason = "error";
    } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        rmSync(pieceDir, { recursive: true, force: true });
    }

    try {
        await finishRecording();
    } catch (err) {
        log.error({ err, meetingId }, "the recording summary could not be written");
    } finally {
        live.close(state.stopReason);

        if (existsSync(files.state)) {
            renameSync(files.state, join(folder, "recorder-last.json"));
        }

        clearPidFile(files.pid);
    }

    log.info(
        { meetingId, frames: state.frames, bytes: state.bytes, stopReason: state.stopReason },
        "recording stopped"
    );
    return state;

    async function finishRecording(): Promise<void> {
        state.stopReason ??= "requested";

        if (runFrames === 0) {
            note(
                `No frame was recorded${state.stopReason === "requested" ? " before the stop" : ""}. Check the recorder: ${toolCommand("control", "doctor")}`
            );
        }

        state.warning = notes.length > 0 ? notes.join("; ") : undefined;
        closeSpan(state.stopReason);
        saveState();
        const stoppedAt = new Date().toISOString();
        const total = existsSync(framesDir) ? framesOnDisk(framesDir) : { frames: 0, bytes: 0, perDisplay: new Map() };
        const current = store.read(meetingId);
        const linked = Object.entries(current?.sources ?? {}).find(([, block]) => typeof block.meetingId === "string");
        let clock: { source: string; startedAt: string } | undefined;

        if (linked && typeof linked[1].meetingId === "string") {
            const source = await meetingSource(linked[0]);
            const sourceClock = await source.recordingClock(linked[1].meetingId).catch((err: unknown) => {
                log.warn({ err }, "recording clock unavailable");
                return null;
            });
            clock = sourceClock ? { source: source.id, startedAt: sourceClock.startedAt } : undefined;
        }

        const failed = state.stopReason === "failed" || state.stopReason === "error";
        const notifyFailure = failed && !current?.recording?.failureNotifiedAt;
        await store.update(
            meetingId,
            {
                command: "record stop",
                change: `${state.frames} frames, ${Math.round(state.bytes / 1_000_000)} MB${total.frames > state.frames ? ` (${total.frames} frames, ${Math.round(total.bytes / 1_000_000)} MB in all)` : ""}, ${state.stopReason}${state.warning && failed ? `, ${state.warning}` : ""}`,
            },
            (next) => {
                const recording: RecordingBlock = {
                    ...next.recording,
                    startedAt: state.startedAt,
                    stoppedAt,
                    frames: total.frames,
                    bytes: total.bytes,
                    status: "stopped",
                    stopReason: state.stopReason,
                    displayPolicy: policy,
                    spans,
                    displays: [...seenDisplays].map(([id, name]) => ({
                        id,
                        name,
                        frames: total.perDisplay.get(id) ?? 0,
                    })),
                    ...(clock ? { clock } : {}),
                    ...(notifyFailure ? { failureNotifiedAt: stoppedAt } : {}),
                };

                if (state.warning) {
                    recording.warning = state.warning;
                } else {
                    delete recording.warning;
                }

                next.recording = recording;
            }
        );

        if (notifyFailure) {
            const byWatcher = readAuto(store)?.meetingId === meetingId;
            await deps.notify({
                title: "Screen recording stopped",
                message: `${state.warning ?? "The capture failed."} ${byWatcher ? `It starts again every ${RETRY_AFTER_MS / 60_000} min while the meeting runs.` : `Start it again: ${toolCommand("meetings", "record", "start", "--meeting", meetingId)}`}`,
                open: folder,
            });
        }
    }
}

/** The live displays of a recorder state, for `record status`. */
export function stateDisplays(state: RecorderState): string {
    return state.displays?.length
        ? state.displays.map((display) => `${display.name} (${display.id})`).join(", ")
        : String(state.display);
}

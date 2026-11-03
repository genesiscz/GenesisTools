import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { z } from "zod";
import { mainDisplay, outputScaleFor, parseDisplayList } from "./displays";
import { runCaptureProcess } from "./process";
import {
    CAPTURE_ENDINGS,
    CAPTURE_TIMEOUT_GRACE_MS,
    type CapturedFrame,
    CaptureError,
    type CaptureErrorKind,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderContext,
    type FrameRecorderSupport,
    MAX_CAPTURE_SECONDS,
} from "./types";

const { log } = logger.scoped("screen-recorder-native");

/** The `ax-tool capture` options that came after the first release; each is used only when `--help` names it. */
export const NATIVE_OPTIONAL_FLAGS = [
    "--display-id",
    "--follow-focus",
    "--max-long-side",
    "--quiet-ms",
    "--heartbeat-sec",
    "--max-mb",
] as const;
export type NativeOptionalFlag = (typeof NATIVE_OPTIONAL_FLAGS)[number];

const HELP_TIMEOUT_MS = 10_000;
const SCREENS_TIMEOUT_MS = 10_000;

const nativeFrame = z.object({
    path: z.string(),
    timestampMs: z.number(),
    changePercent: z.number().default(0),
    reason: z.string().default("change"),
    displayId: z.number().optional(),
    motionBoxes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
});
const nativeResult = z.object({
    data: z.object({
        frames: z.array(nativeFrame).default([]),
        cancelled: z.boolean().optional(),
        endedEarly: z.enum(CAPTURE_ENDINGS).optional(),
        stats: z.record(z.string(), z.number()).optional(),
    }),
});
const nativeError = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });

/** The flags `ax-tool capture --help` names, read once per binary and process. */
const helpCache = new Map<string, Promise<Set<NativeOptionalFlag>>>();

export function flagsInHelp(text: string): Set<NativeOptionalFlag> {
    return new Set(NATIVE_OPTIONAL_FLAGS.filter((flag) => new RegExp(`${flag}(?![\\w-])`).test(text)));
}

function detectFlags(binary: string): Promise<Set<NativeOptionalFlag>> {
    let cached = helpCache.get(binary);

    if (!cached) {
        cached = boundedCommand({ command: [binary, "capture", "--help"], timeoutMs: HELP_TIMEOUT_MS }).then(
            (result) => {
                const flags = flagsInHelp(`${result.stdout}\n${result.stderr}`);
                log.debug({ binary, flags: [...flags] }, "ax-tool capture options");
                return flags;
            }
        );
        helpCache.set(binary, cached);
    }

    return cached;
}

/** Which kind of failure an error code (from the recorder's JSON) or its message names. */
export function captureErrorKind(code: string | undefined, message: string): CaptureErrorKind {
    if (code === "display-missing" || code === "no-permission") {
        return code;
    }

    if (code === "invalid-argument" || code === "failed") {
        return "failed";
    }

    if (
        /screen.index (outside|\d+ not found)|display.*(missing|not connected|not shareable)|no display for/i.test(
            message
        )
    ) {
        return "display-missing";
    }

    if (/permission|not authori[sz]ed|declined|TCC|refused to enumerate/i.test(message)) {
        return "no-permission";
    }

    return "failed";
}

/** The argv after the binary for one capture, with only the flags the binary has. */
export function nativeArgv(options: {
    request: CaptureRequest;
    flags: Set<NativeOptionalFlag>;
    displays: DisplayInfo[];
}): string[] {
    const { request, flags, displays } = options;
    const argv = [
        "capture",
        "--mode",
        "screen",
        "--duration",
        String(Math.min(MAX_CAPTURE_SECONDS, request.durationSec)),
        "--out",
        request.outDir,
        "--active-fps",
        String(Math.max(0.5, request.activeFps)),
        "--idle-fps",
        String(Math.max(0.1, Math.min(request.idleFps, request.activeFps, 5))),
        "--threshold",
        String(request.thresholdPercent),
        "--no-indicator",
    ];
    let display: DisplayInfo | undefined;

    if (request.target.kind === "follow-focus") {
        if (!flags.has("--follow-focus")) {
            throw new CaptureError("unavailable", "this ax-tool has no --follow-focus; rebuild it");
        }

        argv.push("--follow-focus");
    } else {
        const { displayId } = request.target;
        display = displays.find((one) => one.id === displayId);

        if (flags.has("--display-id")) {
            argv.push("--display-id", String(displayId));
        } else if (display) {
            argv.push("--screen-index", String(display.index));
        } else {
            throw new CaptureError("display-missing", `display ${displayId} is not connected`);
        }
    }

    if (request.maxLongSidePx !== undefined) {
        if (flags.has("--max-long-side")) {
            argv.push("--max-long-side", String(request.maxLongSidePx));
        } else {
            const sized = display ?? mainDisplay(displays);

            if (sized) {
                argv.push("--output-scale", String(Number(outputScaleFor(sized, request.maxLongSidePx).toFixed(4))));
            }
        }
    }

    const optional: Array<[NativeOptionalFlag, number | undefined]> = [
        ["--quiet-ms", request.quietMs],
        ["--heartbeat-sec", request.heartbeatSec],
        ["--max-mb", request.maxMb],
    ];

    for (const [flag, value] of optional) {
        if (value !== undefined && flags.has(flag)) {
            argv.push(flag, String(value));
        }
    }

    if (request.maxFrames !== undefined) {
        argv.push("--max-frames", String(request.maxFrames));
    }

    return argv;
}

/** Frames left on disk by a recorder that exited without a result; their times come from the files. */
function salvagedFrames(outDir: string, displayId: number | undefined): CaptureResult | undefined {
    if (!existsSync(outDir)) {
        return undefined;
    }

    const kept = readdirSync(outDir)
        .filter((name) => /^keep-\d+\.png$/.test(name))
        .sort()
        .map((name) => ({ path: join(outDir, name), mtimeMs: statSync(join(outDir, name)).mtimeMs }));
    const first = kept[0];

    if (!first) {
        return undefined;
    }

    return {
        startedAtMs: first.mtimeMs,
        endedEarly: "stream-error",
        frames: kept.map((file) => ({
            path: file.path,
            atMs: Math.round(file.mtimeMs - first.mtimeMs),
            changePercent: 0,
            reason: "salvaged",
            ...(displayId !== undefined ? { displayId } : {}),
        })),
    };
}

/** `ax-tool capture --mode screen`, GenesisTools' own ScreenCaptureKit recorder. */
export class NativeFrameRecorder extends FrameRecorder {
    readonly id = "native" as const;
    private flags = new Set<NativeOptionalFlag>();

    constructor(private readonly context: FrameRecorderContext) {
        super();
    }

    get supports(): FrameRecorderSupport {
        return {
            followFocus: this.flags.has("--follow-focus"),
            displayId: true,
            // Motion boxes came with the same ax-tool release as --follow-focus.
            motionBoxes: this.flags.has("--follow-focus"),
            heartbeat: this.flags.has("--heartbeat-sec"),
        };
    }

    private async binary(signal?: AbortSignal): Promise<string> {
        const binary = await this.context.axToolBinary({
            signal,
            onBuild: () => log.info("building ax-tool before the capture"),
        });
        this.flags = await detectFlags(binary);
        return binary;
    }

    async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
        try {
            await this.binary();
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    async displays(): Promise<DisplayInfo[]> {
        const binary = await this.binary();
        const result = await boundedCommand({ command: [binary, "screens"], timeoutMs: SCREENS_TIMEOUT_MS });

        if (result.status !== 0) {
            throw new CaptureError("unavailable", `ax-tool screens exited ${result.status}: ${result.stderr.trim()}`);
        }

        return parseDisplayList(SafeJSON.parse(result.stdout, { strict: true }));
    }

    async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        const binary = await this.binary(signal);
        const byIndex = request.target.kind === "display" && !this.flags.has("--display-id");
        const byScale = request.maxLongSidePx !== undefined && !this.flags.has("--max-long-side");
        const displays = byIndex || byScale ? await this.displays() : [];
        const argv = [binary, ...nativeArgv({ request, flags: this.flags, displays })];
        const targetId = request.target.kind === "display" ? request.target.displayId : undefined;
        const spawnedAt = Date.now();
        const run = await runCaptureProcess({
            argv,
            timeoutMs: Math.min(MAX_CAPTURE_SECONDS, request.durationSec) * 1000 + CAPTURE_TIMEOUT_GRACE_MS,
            signal,
        });
        log.debug({ exitCode: run.exitCode, argv, timedOut: run.timedOut }, "native capture");

        if (run.timedOut) {
            throw new CaptureError(
                "timeout",
                `ax-tool capture did not end within ${request.durationSec} s + ${CAPTURE_TIMEOUT_GRACE_MS / 1000} s`
            );
        }

        const json = SafeJSON.parse(run.stdout.slice(Math.max(0, run.stdout.indexOf("{"))) || "null");
        const parsed = nativeResult.safeParse(json);

        if (run.exitCode === 0 && parsed.success) {
            const { frames, cancelled, endedEarly, stats } = parsed.data.data;
            const first = frames[0];
            const firstMtime = first ? statSync(first.path, { throwIfNoEntry: false })?.mtimeMs : undefined;
            const kept: CapturedFrame[] = frames.map((frame) => ({
                path: frame.path,
                atMs: frame.timestampMs,
                changePercent: frame.changePercent,
                reason: frame.reason,
                ...(frame.displayId !== undefined || targetId !== undefined
                    ? { displayId: frame.displayId ?? targetId }
                    : {}),
                ...(frame.motionBoxes ? { motionBoxes: frame.motionBoxes } : {}),
            }));
            const ending = endedEarly ?? (cancelled || run.aborted ? "stopped" : undefined);
            return {
                startedAtMs: first && firstMtime !== undefined ? firstMtime - first.timestampMs : spawnedAt,
                frames: kept,
                ...(ending ? { endedEarly: ending } : {}),
                ...(stats ? { stats } : {}),
            };
        }

        const failure = nativeError.safeParse(json);
        const message = failure.success ? failure.data.error : run.stderr.trim().slice(-300) || "no output";
        const salvaged = salvagedFrames(request.outDir, targetId);

        if (salvaged) {
            log.warn({ message, frames: salvaged.frames.length }, "native capture failed; kept its frames");
            return salvaged;
        }

        throw new CaptureError(
            captureErrorKind(failure.success ? failure.data.code : undefined, message),
            `ax-tool capture exited ${run.exitCode}: ${message}`
        );
    }
}

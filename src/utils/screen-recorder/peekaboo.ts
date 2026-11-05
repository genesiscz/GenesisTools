import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { z } from "zod";
import { parseDisplayList } from "./displays";
import { runCaptureProcess } from "./process";
import {
    CAPTURE_TIMEOUT_GRACE_MS,
    CaptureError,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderSupport,
    MAX_CAPTURE_SECONDS,
} from "./types";

const { log } = logger.scoped("screen-recorder-peekaboo");

const LIST_TIMEOUT_MS = 10_000;

const liveOutput = z.object({
    success: z.boolean(),
    data: z
        .object({
            frames: z
                .array(
                    z.object({
                        timestampMs: z.number(),
                        path: z.string(),
                        changePercent: z.number().optional(),
                        reason: z.string().optional(),
                    })
                )
                .default([]),
        })
        .optional(),
});

const peekabooError = z.object({ error: z.object({ code: z.string().optional(), message: z.string() }) });

function parseOutput(stdout: string): unknown {
    try {
        return SafeJSON.parse(stdout.trim() || "null", { strict: true });
    } catch (error) {
        log.debug({ error }, "peekaboo output is not complete JSON");
        return null;
    }
}

/** Peekaboo's own log lines ("[Visualizer][INFO] …"): never the reason a capture failed. */
const PEEKABOO_LOG_LINE = /^\[[^\]]+\]\[(?:INFO|DEBUG|TRACE)\]/;

/** Why peekaboo failed when it printed no JSON error: stderr without its log lines, else stdout, else a plain note. */
function plainReason(stdout: string, stderr: string): string {
    const lines = (text: string) =>
        text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !PEEKABOO_LOG_LINE.test(line));
    const said = [...lines(stderr), ...lines(stdout)].join(" ").slice(-300);

    if (said) {
        return said;
    }

    log.warn({ stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) }, "peekaboo failed without saying why");
    return "peekaboo printed no reason (only its log lines; the day log has its whole output)";
}

/** A failed peekaboo run as a CaptureError: peekaboo prints its own error as JSON on stdout; stderr holds its log. */
export function peekabooCaptureError(exitCode: number | null, stdout: string, stderr: string): CaptureError {
    const parsed = peekabooError.safeParse(parseOutput(stdout));
    const reason = parsed.success ? parsed.data.error.message : plainReason(stdout, stderr);
    const kind = parsed.success && /screen index \d+ not found/i.test(reason) ? "display-missing" : "failed";
    return new CaptureError(
        /permission|not authori[sz]ed/i.test(reason) ? "no-permission" : kind,
        `peekaboo exited ${exitCode}: ${reason}`
    );
}

/** Peekaboo's `capture live`: change-aware frames of one screen index. No follow-focus, no motion boxes. */
export class PeekabooFrameRecorder extends FrameRecorder {
    readonly id = "peekaboo" as const;
    readonly supports: FrameRecorderSupport = {
        followFocus: false,
        displayId: false,
        motionBoxes: false,
        heartbeat: false,
        liveControl: false,
        // Measured 2026-11-03: a second capture fails with "Timed out waiting for the exclusive ScreenCaptureKit
        // operation lock".
        parallelCaptures: false,
        audio: false,
    };

    async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
        const result = await boundedCommand({ command: ["peekaboo", "--version"], timeoutMs: LIST_TIMEOUT_MS });
        return result.status === 0 ? { ok: true } : { ok: false, reason: result.error?.message ?? result.stderr };
    }

    async displays(): Promise<DisplayInfo[]> {
        const result = await boundedCommand({
            command: ["peekaboo", "screen", "list", "--json", "--no-remote"],
            timeoutMs: LIST_TIMEOUT_MS,
        });

        if (result.status !== 0) {
            throw peekabooCaptureError(result.status, result.stdout, result.stderr);
        }

        const parsed = parseOutput(result.stdout);

        if (parsed === null) {
            throw new CaptureError("failed", "peekaboo screen list returned invalid JSON");
        }

        return parseDisplayList(parsed);
    }

    async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        if (request.target.kind !== "display") {
            throw new CaptureError("unavailable", "peekaboo cannot follow the focused display");
        }

        const { displayId } = request.target;
        const display = (await this.displays()).find((one) => one.id === displayId);

        if (!display) {
            throw new CaptureError("display-missing", `display ${displayId} is not connected`);
        }

        const durationSec = Math.min(MAX_CAPTURE_SECONDS, request.durationSec);
        const argv = [
            "peekaboo",
            "capture",
            "live",
            "--mode",
            "screen",
            "--screen-index",
            String(display.index),
            "--duration",
            `${durationSec}s`,
            "--active-fps",
            String(Math.max(0.5, request.activeFps)),
            "--idle-fps",
            String(Math.max(0.1, Math.min(request.idleFps, request.activeFps))),
            "--threshold",
            String(request.thresholdPercent),
            ...(request.maxLongSidePx !== undefined ? ["--resolution-cap", String(request.maxLongSidePx)] : []),
            "--path",
            request.outDir,
            "--json",
            "--no-remote",
        ];
        const startedAtMs = Date.now();
        const run = await runCaptureProcess({
            argv,
            timeoutMs: durationSec * 1000 + CAPTURE_TIMEOUT_GRACE_MS,
            signal,
        });
        log.debug({ exitCode: run.exitCode, timedOut: run.timedOut, dir: request.outDir }, "peekaboo capture");

        if (run.timedOut) {
            throw new CaptureError(
                "timeout",
                `peekaboo did not end within ${durationSec} s + ${CAPTURE_TIMEOUT_GRACE_MS / 1000} s`
            );
        }

        const parsed = liveOutput.safeParse(parseOutput(run.stdout));

        if (run.aborted && (run.exitCode !== 0 || !parsed.success)) {
            log.info({ exitCode: run.exitCode }, "peekaboo stopped before it printed its frames");
            return { startedAtMs, frames: [], endedEarly: "stopped" };
        }

        if (run.exitCode !== 0 || !parsed.success) {
            throw peekabooCaptureError(run.exitCode, run.stdout, run.stderr);
        }

        return {
            startedAtMs,
            frames: (parsed.data.data?.frames ?? []).map((frame) => ({
                path: frame.path,
                atMs: frame.timestampMs,
                displayId,
                changePercent: frame.changePercent ?? 0,
                reason: frame.reason ?? "change",
            })),
            ...(run.aborted ? { endedEarly: "stopped" as const } : {}),
        };
    }
}

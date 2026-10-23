import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCapturePlanWithSignal } from "@app/control/lib/capture-runner";
import { captureFromFlags } from "@app/control/lib/native-record";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { readProcessBasics } from "@genesiscz/utils/process/process-basics";
import { z } from "zod";
import { widgetRoot } from "./storage";

const recordingSchema = z.object({ pid: z.number().int().positive(), path: z.string() });

/** The widget's longest recording: under the widget's 120 s call timeout, with room to finish the movie. */
export const WIDGET_VIDEO_MAX_SECONDS = 90;

function recordingFile(root?: string): string {
    return join(widgetRoot(root), "recording.json");
}

/**
 * Records the visible windows of one app as an H.264 movie with the ScreenCaptureKit recorder that
 * `tools control capture record` uses, until `WIDGET_VIDEO_MAX_SECONDS` or a `stopWidgetVideo` call. The movie is
 * imported by the caller as a video asset, so it gets the same frame review and trim as a pasted video. One
 * recording at a time: its pid is in `recording.json` for the stop action.
 */
export async function recordWidgetVideo({
    root,
    app,
    signal,
}: {
    root?: string;
    /** An app name or pid, as `tools control capture record --include-app` takes it. */
    app: string;
    signal?: AbortSignal;
}): Promise<{ path: string; cancelled: boolean }> {
    await mkdir(widgetRoot(root), { recursive: true });
    const marker = recordingFile(root);
    const running = await readRecording(root);
    if (running && readProcessBasics(running.pid) !== null) {
        throw new Error("A video is already recording. Stop it before starting another.");
    }

    const path = join(widgetRoot(root), `capture-${randomUUID()}.mp4`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    await writeFile(marker, SafeJSON.stringify({ pid: process.pid, path, startedAt: Date.now() }));
    try {
        const capture = captureFromFlags({
            includeApp: [app],
            duration: String(WIDGET_VIDEO_MAX_SECONDS),
            videoOut: path,
            codec: "h264",
        });
        const result = await runCapturePlanWithSignal({ plan: { capture, actions: [] }, signal: controller.signal });
        if (!existsSync(path)) {
            throw new Error(
                result.captureFailed ? "The recorder stopped before it wrote the movie." : "The recording has no movie."
            );
        }

        return { path, cancelled: controller.signal.aborted };
    } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
        signal?.removeEventListener("abort", abort);
        try {
            await unlink(marker);
        } catch (error) {
            logger.debug({ error, path: marker }, "Recording marker cleanup ended");
        }
    }
}

async function readRecording(root?: string): Promise<{ pid: number; path: string } | null> {
    try {
        const parsed = recordingSchema.safeParse(
            SafeJSON.parse(await readFile(recordingFile(root), "utf8"), { strict: true })
        );
        return parsed.success ? parsed.data : null;
    } catch (error) {
        logger.debug({ error }, "No widget recording marker");
        return null;
    }
}

/** Ends the running widget recording: the recorder finishes the movie and the record action imports it. */
export async function stopWidgetVideo(root?: string): Promise<{ stopped: boolean }> {
    const running = await readRecording(root);
    if (!running || readProcessBasics(running.pid) === null) {
        return { stopped: false };
    }

    // pid-verified: the marker names the widget call process that writes and removes it around its recording.
    process.kill(running.pid, "SIGINT");
    return { stopped: true };
}

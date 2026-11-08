import { loadavg } from "node:os";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { OcrOptions } from "./ocr";
import { type FrameBoxes, recognizeTextBoxes } from "./ocr-boxes";

const { log } = logger.scoped("ocr-queue");

/** A Vision read gets this long first (darwinkit's own deadline). */
export const OCR_FIRST_TIMEOUT_MS = 60_000;
/** A read that timed out is tried once more with this long. */
export const OCR_RETRY_TIMEOUT_MS = 180_000;
/** How long a read waits for its turn behind the other scans on this Mac. */
export const OCR_QUEUE_WAIT_MS = 30 * 60_000;

/** darwinkit's refusal of a request that ran past its deadline ("Request vision.ocr timed out after 60000ms"). */
function timedOut(error: unknown): boolean {
    return error instanceof Error && /timed out after/i.test(error.message);
}

/**
 * Vision OCR of one frame, one read at a time on this Mac: every process that scans a movie (three editors at once, a
 * meeting's frames) waits its turn on one lock file instead of sending its reads in parallel, where each one ran past
 * darwinkit's 60 s deadline. A read that still times out is tried once more with 180 s; when that fails too, the error
 * says why (the Mac's load, the queue) and that nothing was saved. `what` names the frame in that message.
 */
export async function recognizeTextBoxesQueued(
    path: string,
    options: OcrOptions & {
        what?: string;
        /** The lock file; absent is the machine's one (`~/.genesis-tools/ocr/vision-queue.lock`). */
        lockPath?: string;
        queueWaitMs?: number;
        /** The read itself (a test passes its own). */
        reader?: (path: string, options: OcrOptions) => Promise<FrameBoxes & { text: string }>;
    } = {}
): Promise<FrameBoxes & { text: string }> {
    const { what = path, lockPath, queueWaitMs = OCR_QUEUE_WAIT_MS, reader = recognizeTextBoxes, ...ocr } = options;
    const lock = lockPath ?? toolDataDir("ocr", "vision-queue.lock");
    const attempt = (timeoutMs: number) => withFileLock(lock, () => reader(path, { ...ocr, timeoutMs }), queueWaitMs);

    try {
        try {
            return await attempt(OCR_FIRST_TIMEOUT_MS);
        } catch (error) {
            if (!timedOut(error)) {
                throw error;
            }

            log.warn(
                { what, load: loadavg()[0], timeoutMs: OCR_FIRST_TIMEOUT_MS },
                "a Vision read timed out; it is tried once more with a longer deadline"
            );
            return await attempt(OCR_RETRY_TIMEOUT_MS);
        }
    } catch (error) {
        const load = loadavg()[0].toFixed(1);

        if (timedOut(error)) {
            throw new Error(
                `Vision OCR of ${what} did not answer within ${OCR_FIRST_TIMEOUT_MS / 1000} s, nor within ${OCR_RETRY_TIMEOUT_MS / 1000} s on a second try: the Mac is busy (load ${load}) or Vision is stuck. Nothing was saved; run it again when fewer scans run.`,
                { cause: error }
            );
        }

        if (error instanceof LockTimeoutError) {
            throw new Error(
                `Vision OCR of ${what} waited ${Math.round(queueWaitMs / 60_000)} min for its turn behind other OCR scans on this Mac (load ${load}) and gave up. Nothing was saved; run it again when they finish.`,
                { cause: error }
            );
        }

        throw error;
    }
}

import { createWriteStream, existsSync, renameSync, statSync, truncateSync, type WriteStream } from "node:fs";
import { logger } from "@genesiscz/utils/logger";

export interface FileDownloadProgress {
    /** Bytes in the part file, earlier runs included. */
    bytes: number;
    /** The full size, when the server says it. */
    total: number | null;
    /** Bytes that were already on disk when this run started. */
    resumedFrom: number;
}

export interface FileDownloadResult {
    output: string;
    bytes: number;
    total: number | null;
    resumedFrom: number;
    /** False when the signal stopped it; the part file stays for a resume. */
    complete: boolean;
}

/** Network failures in a row before the download gives up; each one resumes where the last stopped. */
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 3000;
/** An attempt that receives no byte for this long is dropped and resumed, so a stalled server cannot hang the run. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export function partFileFor(output: string): string {
    return `${output}.part`;
}

/** `bytes 100-199/1234` gives start 100 and total 1234; a 416 names only the total (`bytes`, a star, then the total). */
export function parseContentRange(header: string | null): { start: number | null; total: number | null } {
    const match = header ? /^bytes\s+(?:(\d+)-\d+|\*)\/(\d+|\*)\s*$/i.exec(header.trim()) : null;

    if (!match) {
        return { start: null, total: null };
    }

    return {
        start: match[1] === undefined ? null : Number(match[1]),
        total: match[2] === "*" ? null : Number(match[2]),
    };
}

function sizeOf(path: string): number {
    return existsSync(path) ? statSync(path).size : 0;
}

async function write(stream: WriteStream, chunk: Uint8Array): Promise<void> {
    if (!stream.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
            const drained = () => {
                stream.off("error", failed);
                resolve();
            };
            const failed = (error: Error) => {
                stream.off("drain", drained);
                reject(error);
            };
            stream.once("drain", drained);
            stream.once("error", failed);
        });
    }
}

async function close(stream: WriteStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
}

/**
 * Downloads one file into `<output>.part`, resuming that part file with a `Range` request, and renames it to `output`
 * once it holds every byte. A dropped connection resumes up to six times; a server that ignores `Range` starts over.
 */
export async function downloadFile({
    url,
    headers,
    output,
    signal,
    onProgress,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    retryDelayMs = RETRY_DELAY_MS,
}: {
    url: string;
    headers: Record<string, string>;
    output: string;
    signal?: AbortSignal;
    onProgress?: (progress: FileDownloadProgress) => void;
    /** An attempt with no byte for this long is aborted and resumed. */
    idleTimeoutMs?: number;
    retryDelayMs?: number;
}): Promise<FileDownloadResult> {
    const part = partFileFor(output);
    const resumedFrom = sizeOf(part);
    let total: number | null = null;
    let failures = 0;

    while (true) {
        const have = sizeOf(part);

        if (total !== null && have >= total) {
            break;
        }

        if (signal?.aborted) {
            return { output, bytes: have, total, resumedFrom, complete: false };
        }

        let stream: WriteStream | null = null;
        const idle = new AbortController();
        let idleTimer = setTimeout(() => idle.abort(new Error("no data")), idleTimeoutMs);
        const touch = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => idle.abort(new Error("no data")), idleTimeoutMs);
        };

        try {
            const response = await fetch(url, {
                headers: have > 0 ? { ...headers, range: `bytes=${have}-` } : headers,
                signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
            });
            touch();
            const range = parseContentRange(response.headers.get("content-range"));

            if (response.status === 416 && have > 0) {
                await response.body?.cancel();

                // Complete only when the server names a length and the part has exactly that many bytes.
                if (range.total === have) {
                    total = have;
                    break;
                }

                logger.warn({ output, have, total: range.total }, "The part does not match the file; starting over");
                truncateSync(part, 0);
                continue;
            }

            if (!response.ok || !response.body) {
                throw new Error(`HTTP ${response.status} for the file download`);
            }

            const append = response.status === 206;

            if (append && range.start !== have) {
                await response.body.cancel();
                logger.warn({ output, have, start: range.start }, "The server resumed at another byte; starting over");
                truncateSync(part, 0);
                continue;
            }

            const length = Number(response.headers.get("content-length") ?? Number.NaN);
            total = append
                ? (range.total ?? (Number.isFinite(length) ? have + length : null))
                : Number.isFinite(length)
                  ? length
                  : null;
            logger.debug({ output, have, append, total, status: response.status }, "File download request");

            stream = createWriteStream(part, { flags: append ? "a" : "w" });
            let bytes = append ? have : 0;

            for await (const chunk of response.body) {
                touch();
                await write(stream, chunk);
                bytes += chunk.byteLength;
                failures = 0;
                onProgress?.({ bytes, total, resumedFrom });
            }

            await close(stream);
            stream = null;

            if (total === null) {
                total = sizeOf(part);
            }
        } catch (error) {
            if (stream) {
                await close(stream).catch((closeError: unknown) => {
                    logger.debug({ error: closeError }, "Could not close the part file");
                });
            }

            if (signal?.aborted) {
                return { output, bytes: sizeOf(part), total, resumedFrom, complete: false };
            }

            failures++;
            logger.warn({ error, output, failures, have: sizeOf(part) }, "File download interrupted; resuming");

            if (failures >= MAX_ATTEMPTS) {
                throw new Error(`The download failed ${failures} times in a row: ${String(error)}`);
            }

            await Bun.sleep(retryDelayMs);
        } finally {
            clearTimeout(idleTimer);
        }
    }

    const bytes = sizeOf(part);

    if (total !== null && bytes !== total) {
        throw new Error(`${part} holds ${bytes} bytes, the server announced ${total}`);
    }

    renameSync(part, output);
    return { output, bytes, total, resumedFrom, complete: true };
}

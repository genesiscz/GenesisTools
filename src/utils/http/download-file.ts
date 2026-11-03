import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from "node:fs";
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

export function partFileFor(output: string): string {
    return `${output}.part`;
}

/** `bytes 0-99/1234` gives 1234; `*` or a missing header gives null. */
function totalFromContentRange(header: string | null): number | null {
    const total = header ? /\/(\d+)\s*$/.exec(header)?.[1] : undefined;
    return total ? Number(total) : null;
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
}: {
    url: string;
    headers: Record<string, string>;
    output: string;
    signal?: AbortSignal;
    onProgress?: (progress: FileDownloadProgress) => void;
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

        try {
            const response = await fetch(url, {
                headers: have > 0 ? { ...headers, range: `bytes=${have}-` } : headers,
                signal,
            });

            if (response.status === 416 && have > 0) {
                // The part already ends where the file ends.
                total = have;
                break;
            }

            if (!response.ok || !response.body) {
                throw new Error(`HTTP ${response.status} for the file download`);
            }

            const append = response.status === 206;
            const length = Number(response.headers.get("content-length") ?? Number.NaN);
            total = append
                ? (totalFromContentRange(response.headers.get("content-range")) ??
                  (Number.isFinite(length) ? have + length : null))
                : Number.isFinite(length)
                  ? length
                  : null;
            logger.debug({ output, have, append, total, status: response.status }, "File download request");

            stream = createWriteStream(part, { flags: append ? "a" : "w" });
            let bytes = append ? have : 0;

            for await (const chunk of response.body) {
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

            await Bun.sleep(RETRY_DELAY_MS);
        }
    }

    const bytes = sizeOf(part);

    if (total !== null && bytes !== total) {
        throw new Error(`${part} holds ${bytes} bytes, the server announced ${total}`);
    }

    renameSync(part, output);
    return { output, bytes, total, resumedFrom, complete: true };
}

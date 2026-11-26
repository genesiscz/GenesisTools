import type { IncomingMessage } from "node:http";
import { logger } from "@genesiscz/utils/logger";

export class RequestBodyTimeoutError extends Error {
    constructor(readonly timeoutMs: number) {
        super(`Request body read timed out after ${timeoutMs} ms`);
        this.name = "RequestBodyTimeoutError";
    }
}

export class RequestBodyTooLargeError extends Error {
    constructor(
        readonly maxBytes: number,
        readonly observedBytes: number
    ) {
        super(`Request body exceeds ${maxBytes} bytes`);
        this.name = "RequestBodyTooLargeError";
    }
}

function declaredLength(headers: Headers | IncomingMessage["headers"]): number | undefined {
    const raw = headers instanceof Headers ? headers.get("content-length") : headers["content-length"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function readBoundedWebBody(
    request: Request,
    maxBytes: number,
    options: { timeoutMs?: number } = {}
): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("A request body read requires a positive finite deadline");
    }

    const declared = declaredLength(request.headers);
    if (declared !== undefined && declared > maxBytes) {
        await request.body?.cancel();
        throw new RequestBodyTooLargeError(maxBytes, declared);
    }

    const reader = request.body?.getReader();
    if (!reader) {
        return new Uint8Array();
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new RequestBodyTimeoutError(timeoutMs));
            void reader.cancel().catch((err: unknown) => logger.debug({ err }, "body reader cancellation failed"));
        }, timeoutMs);
    });
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), deadline]);
            if (done) {
                break;
            }

            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                throw new RequestBodyTooLargeError(maxBytes, bytes);
            }

            chunks.push(value);
        }
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }

    return Buffer.concat(chunks, bytes);
}

export async function readBoundedNodeBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
    const declared = declaredLength(request.headers);
    if (declared !== undefined && declared > maxBytes) {
        request.resume();
        throw new RequestBodyTooLargeError(maxBytes, declared);
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxBytes) {
            request.resume();
            throw new RequestBodyTooLargeError(maxBytes, bytes);
        }

        chunks.push(buffer);
    }

    return Buffer.concat(chunks, bytes);
}

export async function readBoundedRequestText(
    request: Request,
    maxBytes: number,
    options: { timeoutMs?: number } = {}
): Promise<string> {
    return new TextDecoder().decode(await readBoundedWebBody(request, maxBytes, options));
}

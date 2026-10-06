import type { IncomingMessage } from "node:http";

export const DEFAULT_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
export const E2E_REQUEST_BODY_BYTES = 1024 * 1024;
const HANDOFF_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const LARGE_UPLOAD_BYTES = 200 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
    constructor(
        readonly maxBytes: number,
        readonly observedBytes: number
    ) {
        super(`Request body exceeds ${maxBytes} bytes`);
        this.name = "RequestBodyTooLargeError";
    }
}

export function requestBodyLimit(pathname: string): number {
    if (pathname === "/api/e2e/rpc") {
        return E2E_REQUEST_BODY_BYTES;
    }

    if (pathname === "/api/handoff/attach") {
        return HANDOFF_ATTACHMENT_BYTES;
    }

    if (pathname.startsWith("/api/boards/sets/") || /^\/api\/boards\/[^/]+\/(?:upload|msg-uploads)$/.test(pathname)) {
        return LARGE_UPLOAD_BYTES;
    }

    return DEFAULT_REQUEST_BODY_BYTES;
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

export async function readBoundedWebBody(request: Request, maxBytes: number): Promise<Uint8Array> {
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
    try {
        while (true) {
            const { done, value } = await reader.read();
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

export async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
    return new TextDecoder().decode(await readBoundedWebBody(request, maxBytes));
}

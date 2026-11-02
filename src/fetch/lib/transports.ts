import { ImpersonatedBodyTooLargeError, ImpersonatedHttpClient } from "@genesiscz/utils/http/impersonate/client";
import type { HttpTransport, TransportName, TransportRequest, TransportResponse } from "./types";

/**
 * The largest response body a fetch reads, in bytes. No page a reader needs is this large, and the resident MCP server
 * must not buffer an answer of any size because a caller asked for a few tokens of it.
 */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** The response body passed the byte limit; the transfer was stopped before the rest was read. */
export class FetchTooLargeError extends Error {
    constructor(
        readonly url: string,
        readonly maxBytes: number
    ) {
        super(`The response of ${url} is larger than ${maxBytes} bytes; the transfer was stopped`);
        this.name = "FetchTooLargeError";
    }
}

/** The body as UTF-8 text, read chunk by chunk and refused once it passes `maxBytes`, so it is never buffered whole. */
async function boundedText(response: Response, url: string, maxBytes: number): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new FetchTooLargeError(url, maxBytes);
    }

    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        bytes += value.byteLength;
        if (bytes > maxBytes) {
            await reader.cancel();
            throw new FetchTooLargeError(url, maxBytes);
        }

        chunks.push(value);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A desktop Chrome User-Agent for the plain transport. The chrome transport sends libcurl-impersonate's own, matching set. */
const PLAIN_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** Bun's fetch: fast, no extra process, and refused by Cloudflare Bot Management (403 challenge). */
class PlainTransport implements HttpTransport {
    readonly name = "plain" as const;

    async send(request: TransportRequest): Promise<TransportResponse> {
        const timeout = AbortSignal.timeout(request.timeoutMs);
        const response = await fetch(request.url, {
            headers: { ...PLAIN_HEADERS, ...request.headers },
            redirect: "manual",
            signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
        });

        return {
            status: response.status,
            headers,
            body: await boundedText(response, request.url, request.maxBodyBytes),
        };
    }

    async close(): Promise<void> {}
}

export interface ChromeTransportOptions {
    /** Ends the idle worker after this many ms; for a long-lived server. */
    idleCloseMs?: number;
}

/**
 * A real Chrome TLS, HTTP/2 and header fingerprint through libcurl-impersonate (`ImpersonatedHttpClient`). Its
 * worker starts on the first request and keeps one cookie jar, so a clearance cookie carries over to later requests.
 */
class ChromeTransport implements HttpTransport {
    readonly name = "chrome" as const;
    private readonly client: ImpersonatedHttpClient;

    constructor(options: ChromeTransportOptions) {
        this.client = new ImpersonatedHttpClient({
            profile: "chrome",
            label: "fetch",
            idleCloseMs: options.idleCloseMs,
        });
    }

    async send(request: TransportRequest): Promise<TransportResponse> {
        try {
            // The worker stops the transfer past the limit, so the body is never buffered whole nor sent as one message.
            const response = await this.client.request({
                url: request.url,
                headers: request.headers,
                timeoutMs: request.timeoutMs,
                followRedirects: false,
                signal: request.signal,
                maxBodyBytes: request.maxBodyBytes,
            });

            return { status: response.status, headers: response.headers, body: response.text };
        } catch (error) {
            if (error instanceof ImpersonatedBodyTooLargeError) {
                throw new FetchTooLargeError(request.url, error.maxBodyBytes);
            }

            throw error;
        }
    }

    close(): Promise<void> {
        return this.client.close();
    }
}

export interface TransportOptions {
    chrome: ChromeTransportOptions;
}

/** Every transport, by name. A new one is a class above and a row here; nothing else names transports. */
export const TRANSPORTS: Record<TransportName, (options: TransportOptions) => HttpTransport> = {
    plain: () => new PlainTransport(),
    chrome: (options) => new ChromeTransport(options.chrome),
};

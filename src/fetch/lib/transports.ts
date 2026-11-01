import { ImpersonatedHttpClient } from "@genesiscz/utils/http/impersonate/client";
import type { HttpTransport, TransportName, TransportRequest, TransportResponse } from "./types";

/** A desktop Chrome User-Agent for the plain transport. The chrome transport sends curl_cffi's own, matching set. */
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

        return { status: response.status, headers, body: await response.text() };
    }

    async close(): Promise<void> {}
}

export interface ChromeTransportOptions {
    /** Ends the idle sidecar after this many ms; for a long-lived server. */
    idleCloseMs?: number;
}

/**
 * A real Chrome TLS, HTTP/2 and header fingerprint through the curl_cffi sidecar (`ImpersonatedHttpClient`). The
 * sidecar starts on the first request and keeps one cookie jar, so a clearance cookie carries over to later requests.
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
        const response = await this.client.request({
            url: request.url,
            headers: request.headers,
            timeoutMs: request.timeoutMs,
            followRedirects: false,
            signal: request.signal,
        });

        return { status: response.status, headers: response.headers, body: response.text };
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

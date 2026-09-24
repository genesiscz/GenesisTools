export class HttpError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly body?: string;

    constructor({ status, statusText, url, body }: { status: number; statusText: string; url: string; body?: string }) {
        super(`${status} ${statusText}: ${url}${body ? ` — ${body.slice(0, 200)}` : ""}`);
        this.name = "HttpError";
        this.status = status;
        this.statusText = statusText;
        this.url = url;
        this.body = body;
    }
}

/** Statuses worth a second attempt: request timeout, throttling, and server-side faults. */
export function isRetryableHttpStatus(status: number): boolean {
    return status === 408 || status === 429 || (status >= 500 && status < 600);
}

const TRANSPORT_ERROR_CODES = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "ConnectionClosed",
    "ConnectionRefused",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
]);

/** A failure of the connection, as opposed to a bug in our own code. */
export function isTransportError(error: Error): boolean {
    const code = (error as { code?: unknown }).code;

    if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) {
        return true;
    }

    const cause = (error as { cause?: unknown }).cause;

    if (cause instanceof Error && isTransportError(cause)) {
        return true;
    }

    return /fetch failed|network error|socket|connection (closed|refused|reset)|timed? ?out/i.test(error.message);
}

/**
 * Retry retryable HTTP statuses and transport failures only. A TypeError from
 * our own code is a bug, and retrying it three times just hides it.
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof HttpError) {
        return isRetryableHttpStatus(error.status);
    }

    if (!(error instanceof Error) || error.name === "AbortError") {
        return false;
    }

    return isTransportError(error);
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message);
    }

    return String(error);
}

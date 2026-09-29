export const GATEWAY_VERIFICATION_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card";

export type EvaluationErrorCode = "cancelled" | "authentication" | "rate-limit" | "provider" | "request-limit";

/**
 * A failed Jev call with a machine-readable `code`. The message is the string the evaluator threw
 * before this class existed (`Evaluation stopped.` on abort, the describe*Failure text otherwise), so
 * a caller that reads only `.message` sees no change. `tools jev grep` switches on `code`.
 *
 * It never carries the provider error as `cause`: an `APICallError` holds `requestBodyValues`, which
 * is the whole evaluation state, and a logged cause would write that state into the log file.
 */
export class EvaluationError extends Error {
    readonly code: EvaluationErrorCode;
    readonly statusCode?: number;
    /** From a 429's `Retry-After` header; undefined when the header was absent or unreadable. */
    readonly retryAfterMs?: number;
    /**
     * A timeout, a reset connection, or HTTP 408, 429 or 5xx: the same request may succeed later.
     * Only a caller that knows its batch can turn this into "split the batch".
     */
    readonly transient: boolean;

    constructor(options: {
        code: EvaluationErrorCode;
        message: string;
        statusCode?: number;
        retryAfterMs?: number;
        transient?: boolean;
    }) {
        super(options.message);
        this.name = "EvaluationError";
        this.code = options.code;
        this.statusCode = options.statusCode;
        this.retryAfterMs = options.retryAfterMs;
        this.transient = options.transient ?? false;
    }
}

function retryAfterMs(headers: unknown): number | undefined {
    if (!headers || typeof headers !== "object") {
        return undefined;
    }

    const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
    if (typeof raw !== "string") {
        return undefined;
    }

    const seconds = Number(raw);
    if (raw.trim() && Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Read the failure class from the provider error object itself, before it is flattened into a
 * message. Walks the `cause` chain the same five levels `describeGatewayFailure` does, because the
 * Gateway provider wraps the `APICallError` that carries the status and headers.
 */
export function classifyEvaluationFailure(
    error: unknown
): Pick<EvaluationError, "code" | "statusCode" | "retryAfterMs" | "transient"> {
    let current: unknown = error;
    let statusCode: number | undefined;
    let retryAfter: number | undefined;
    let timedOut = false;
    let network = false;

    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
        if ("statusCode" in current && typeof current.statusCode === "number") {
            statusCode ??= current.statusCode;
        }

        if ("responseHeaders" in current) {
            retryAfter ??= retryAfterMs(current.responseHeaders);
        }

        if ("name" in current && (current.name === "TimeoutError" || current.name === "AbortError")) {
            timedOut = true;
        }

        if (
            "isRetryable" in current &&
            current.isRetryable === true &&
            !("statusCode" in current && current.statusCode)
        ) {
            network = true;
        }

        current = "cause" in current ? current.cause : undefined;
    }

    if (statusCode === 401 || statusCode === 403) {
        return { code: "authentication", statusCode, transient: false };
    }

    if (statusCode === 429) {
        return { code: "rate-limit", statusCode, retryAfterMs: retryAfter, transient: true };
    }

    const transient =
        timedOut ||
        network ||
        statusCode === 408 ||
        (statusCode !== undefined && statusCode >= 500 && statusCode <= 599);
    return { code: "provider", statusCode, transient };
}

export function describeGatewayFailure({
    error,
    timeoutMs,
    apiKey,
}: {
    error: unknown;
    timeoutMs: number;
    apiKey?: string;
}): string {
    let current: unknown = error;
    let statusCode: number | undefined;
    let timedOut = false;
    let gatewayMessage: string | undefined;

    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
        if ("statusCode" in current && typeof current.statusCode === "number") {
            statusCode ??= current.statusCode;
        }

        if ("name" in current && (current.name === "TimeoutError" || current.name === "AbortError")) {
            timedOut = true;
        }

        const message = "message" in current && typeof current.message === "string" ? current.message : "";
        const name = "name" in current && typeof current.name === "string" ? current.name : "";
        if (name.startsWith("Gateway") && message && !message.trimStart().startsWith("{")) {
            const redacted = apiKey ? message.split(apiKey).join("[REDACTED]") : message;
            gatewayMessage ??= redacted.slice(0, 2000);
        }

        if (message.includes("customer_verification_required") || message.includes("valid credit card on file")) {
            return `Vercel requires a credit card on your account before AI Gateway can serve requests. Complete verification at ${GATEWAY_VERIFICATION_URL}, then rerun the command. You do not need to replace your API key.`;
        }

        if (
            message.includes("ZdrUnauthorizedError") ||
            message.includes("Zero Data Retention (ZDR) is only available")
        ) {
            return "The --zdr option requires Vercel Pro or Enterprise. Omit --zdr to use standard gateway retention, or upgrade your Vercel plan. Your API key does not need replacing.";
        }

        current = "cause" in current ? current.cause : undefined;
    }

    if (timedOut) {
        return `Jev request timed out after ${timeoutMs} ms.`;
    }

    if (statusCode === 401) {
        return "AI Gateway rejected the credential. Run `tools jev login` with an AI Gateway API key.";
    }

    if (gatewayMessage) {
        return `AI Gateway: ${gatewayMessage}`;
    }

    if (statusCode === 403) {
        return "AI Gateway denied access (HTTP 403). Check account verification, team permissions and key restrictions in your Vercel dashboard.";
    }

    if (statusCode === 402) {
        return "AI Gateway needs credits or a budget increase. Check your Vercel AI Gateway dashboard.";
    }

    return `Jev request failed${statusCode ? ` (HTTP ${statusCode})` : ""}. Check AI Gateway logs or retry.`;
}

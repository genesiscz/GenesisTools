export const GATEWAY_VERIFICATION_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card";

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

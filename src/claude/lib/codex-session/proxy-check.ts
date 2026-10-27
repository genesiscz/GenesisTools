import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Why the proxy would refuse this session's key, or undefined when it takes it. `/health` answers without a key, so a
 * proxy started before session keys (2026-10-25) passes it and then answers every request of the session with 401,
 * which Claude Code retries ten times with no hint. count_tokens checks the key and never reaches an upstream.
 * Any other failure is only logged: the check must not block a launch on a question it was not built to answer.
 */
export async function sessionKeyProblem(input: {
    baseUrl: string;
    key: string;
    model: string;
    timeoutMs?: number;
}): Promise<string | undefined> {
    const url = `${input.baseUrl}/v1/messages/count_tokens`;
    let response: Response;

    try {
        response = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" },
            body: SafeJSON.stringify({ model: input.model, messages: [{ role: "user", content: "ping" }] }),
            // A busy proxy answered count_tokens after more than 3 s on 2026-10-27 (load average 300 and up).
            signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
        });
    } catch (error) {
        // The message only: the whole DOMException printed 25 lines of error codes over the launch (2026-10-27).
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn({ url, reason }, "[codex] the session key check got no answer; starting anyway");
        return undefined;
    }

    if (response.ok) {
        return undefined;
    }

    let detail: string | undefined;
    try {
        detail = errorMessage(await response.text());
    } catch (error) {
        logger.warn({ error, url, status: response.status }, "[codex] could not read the session key check response");
    }
    logger.warn({ url, status: response.status, detail }, "[codex] the proxy refused the session key check");

    if (response.status === 401) {
        return (
            `The ai-proxy at ${input.baseUrl} answered this session's key with 401 (${detail ?? "no message"}). ` +
            "The proxy may run code from before session keys or use different authentication settings. " +
            "Confirm which proxy is running before restarting it; a restart also ends its other clients' requests:\n" +
            `  ${toolCommand("ai-proxy down")} && ${toolCommand("ai-proxy up")}`
        );
    }

    if (response.status === 403) {
        return (
            `The ai-proxy at ${input.baseUrl} answered this session's key with 403 (${detail ?? "no message"}). ` +
            "The key may be unknown, closed or replaced by another launch; the proxy may also use a different GENESIS_TOOLS_HOME."
        );
    }

    return undefined;
}

function errorMessage(body: string): string | undefined {
    try {
        const parsed: unknown = SafeJSON.parse(body, { strict: true });

        if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
            const error = parsed.error;

            if (
                typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof error.message === "string"
            ) {
                return error.message;
            }
        }
    } catch (error) {
        logger.debug({ error }, "[codex] the proxy's refusal is not JSON");
    }

    return body.trim().slice(0, 200) || undefined;
}

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
            signal: AbortSignal.timeout(input.timeoutMs ?? 3000),
        });
    } catch (error) {
        logger.warn({ error, url }, "[codex] the session key check got no answer; starting anyway");
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
            "It runs code from before session keys, so every request of this session would fail. " +
            "Restart it; this also ends the requests its other clients have in flight:\n" +
            `  ${toolCommand("ai-proxy down")} && ${toolCommand("ai-proxy up")}`
        );
    }

    if (response.status === 403) {
        return (
            `The ai-proxy at ${input.baseUrl} answered this session's key with 403 (${detail ?? "no message"}). ` +
            "It does not find the session record this launcher just wrote, so it reads another GENESIS_TOOLS_HOME."
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

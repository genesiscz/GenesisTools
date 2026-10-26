/**
 * An upstream failure that is about the ACCOUNT (a usage limit, a plan that cannot serve the model, a dead login, a
 * rate limit, an overloaded model), said in words with the command that changes the account (P8, ❓ DECISION 10 c,
 * Martin 2026-10-25): the proxy no longer moves to another account by itself unless the account's `failover` is on.
 *
 * The status a Claude Code client gets decides what it does. Measured on Claude Code 2.1.296 (2026-10-26 00:04, a
 * fake upstream, `claude -p`): a 400 shows the text at once and stops; 401 and 403 show it behind a false "Failed to
 * authenticate."; 401, 429, 500 and 529 are retried 10 times over about 190 s before the text shows. So an account
 * that cannot serve goes out as 400, a short rate limit stays 429 (Claude Code's own backoff suits it), and an
 * overloaded model goes out as 529 so Claude Code retries it.
 */
import type { SessionAgent } from "@app/ai-proxy/lib/sessions/records";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatDateTime } from "@genesiscz/utils/date";
import { formatDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

export type UpstreamFailureKind = "usage-limit" | "plan" | "rate-limit" | "auth" | "overloaded";

export interface UpstreamFailure {
    kind: UpstreamFailureKind;
    /** The upstream's HTTP status. */
    status: number;
    /** The upstream's own error type or code (`usage_limit_reached`, `server_is_overloaded`). */
    code?: string;
    message?: string;
    /** When the limit resets, epoch ms. */
    resetsAtMs?: number;
    retryAfterSec?: number;
}

/** codex-rs `is_server_overloaded_error`. */
const OVERLOADED_CODES = new Set(["server_is_overloaded", "slow_down"]);
/** WHAM's 400 for a model the ChatGPT plan does not include. */
const MODEL_NOT_ON_PLAN = /not supported when using Codex with a ChatGPT account/i;

interface ErrorBody {
    type?: string;
    code?: string;
    message?: string;
    resetsAt?: number;
    resetsInSeconds?: number;
}

function stringField(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** WHAM `{error:{type,code,message,resets_at,resets_in_seconds}}`, FastAPI `{detail}` or Grok `{code,error}`. */
function parseErrorBody(bodyText: string): ErrorBody {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(bodyText, { strict: true });
    } catch (err) {
        logger.debug({ err, bodyPreview: bodyText.slice(0, 200) }, "ai-proxy: upstream error body is not JSON");
        return bodyText.trim() ? { message: bodyText.trim().slice(0, 300) } : {};
    }

    if (!isObject(parsed)) {
        return {};
    }

    if (isObject(parsed.error)) {
        const error = parsed.error;
        return {
            type: stringField(error.type),
            code: stringField(error.code),
            message: stringField(error.message),
            resetsAt: numberField(error.resets_at),
            resetsInSeconds: numberField(error.resets_in_seconds),
        };
    }

    return {
        code: stringField(parsed.code),
        message: stringField(parsed.detail) ?? stringField(parsed.error) ?? stringField(parsed.message),
    };
}

/**
 * The account-level failure an upstream error is, or undefined for any other error (a malformed request, a 5xx),
 * which keeps its own status and message.
 */
export function classifyUpstreamFailure(input: {
    status: number;
    bodyText: string;
    retryAfterSec?: number;
    now?: number;
}): UpstreamFailure | undefined {
    const body = parseErrorBody(input.bodyText);
    const code = body.type ?? body.code;
    const base = {
        status: input.status,
        ...(code ? { code } : {}),
        ...(body.message ? { message: body.message } : {}),
        ...(input.retryAfterSec != null ? { retryAfterSec: input.retryAfterSec } : {}),
    };

    if (code === "usage_not_included" || (input.status === 400 && MODEL_NOT_ON_PLAN.test(body.message ?? ""))) {
        return { kind: "plan", ...base };
    }

    if (code && OVERLOADED_CODES.has(code)) {
        return { kind: "overloaded", ...base };
    }

    if (input.status === 429) {
        const now = input.now ?? Date.now();
        const resetsAtMs = body.resetsAt
            ? body.resetsAt * 1000
            : body.resetsInSeconds
              ? now + body.resetsInSeconds * 1000
              : undefined;

        if (code === "usage_limit_reached" || resetsAtMs) {
            return { kind: "usage-limit", ...base, ...(resetsAtMs ? { resetsAtMs } : {}) };
        }

        return { kind: "rate-limit", ...base };
    }

    if (input.status === 401) {
        return { kind: "auth", ...base };
    }

    return undefined;
}

/** A Codex Responses stream that failed before any output because the model is at capacity (codex-rs retries it). */
export function overloadedStreamFailure(event: Record<string, unknown>): UpstreamFailure | undefined {
    if (event.type !== "response.failed" || !isObject(event.response) || !isObject(event.response.error)) {
        return undefined;
    }

    const code = stringField(event.response.error.code);

    if (!code || !OVERLOADED_CODES.has(code)) {
        return undefined;
    }

    const message = stringField(event.response.error.message);
    return { kind: "overloaded", status: 200, code, ...(message ? { message } : {}) };
}

/** The events a Responses stream opens with before any output. */
const PREAMBLE_EVENTS = new Set(["response.created", "response.in_progress"]);

/** What the complete events in `text` say so far: still in the preamble, an overload, or a stream that has started. */
function headVerdict(text: string): "pending" | "open" | UpstreamFailure {
    const events = text.split(/\r?\n\r?\n/);
    events.pop();

    for (const event of events) {
        const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

        if (!data) {
            continue;
        }

        let parsed: unknown;

        try {
            parsed = SafeJSON.parse(data, { strict: true });
        } catch (err) {
            logger.debug({ err }, "ai-proxy: stream head event is not JSON; the stream passes through");
            return "open";
        }

        if (!isObject(parsed)) {
            return "open";
        }

        if (typeof parsed.type === "string" && PREAMBLE_EVENTS.has(parsed.type)) {
            continue;
        }

        return overloadedStreamFailure(parsed) ?? "open";
    }

    return "pending";
}

/**
 * Read a Responses stream up to its first event after the preamble. An overload there comes back as a failure (and
 * the stream is cancelled); anything else comes back as a stream that replays what was read, then the rest.
 */
export async function readStreamHead(
    body: ReadableStream<Uint8Array>
): Promise<{ failure: UpstreamFailure } | { body: ReadableStream<Uint8Array> }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const read: Uint8Array[] = [];
    let text = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        read.push(value);
        text += decoder.decode(value, { stream: true });
        const verdict = headVerdict(text);

        if (verdict === "pending") {
            continue;
        }

        if (verdict !== "open") {
            await reader.cancel();
            return { failure: verdict };
        }

        break;
    }

    return {
        body: new ReadableStream<Uint8Array>({
            async pull(controller) {
                const next = read.shift();

                if (next) {
                    controller.enqueue(next);
                    return;
                }

                const { done, value } = await reader.read();

                if (done) {
                    controller.close();
                    return;
                }

                controller.enqueue(value);
            },
            cancel(reason) {
                return reader.cancel(reason);
            },
        }),
    };
}

/** The status a Claude Code client gets (see the measurement at the top). */
export function anthropicClientStatus(failure: UpstreamFailure): number {
    switch (failure.kind) {
        case "usage-limit":
        case "plan":
        case "auth":
            return 400;
        case "overloaded":
            return 529;
        case "rate-limit":
            return 429;
    }
}

export interface FailureContext {
    agent: SessionAgent;
    /** The configured proxy account, for the failover command. */
    proxyAccount: string;
    /** The account as the user knows it: the login, else the proxy account. */
    account: string;
    /** The managed login the account bills, for the log-in-again hint. Absent: the Codex CLI's own auth.json. */
    login?: string;
    model: string;
    /** The session record the request came from: the text names its switch command. */
    sessionId?: string;
    failover: boolean;
    /** Which proxy accounts were tried, when failover moved through more than one. */
    tried?: string[];
}

const AGENT_LABEL: Record<SessionAgent, string> = { codex: "Codex", claude: "Claude", grok: "Grok" };

const WHAT: Record<UpstreamFailureKind, string> = {
    "usage-limit": "hit its usage limit",
    plan: "cannot serve this model on its plan",
    "rate-limit": "is rate limited",
    auth: "was refused after a token refresh",
    overloaded: "answered that the model is overloaded",
};

/** How to log an agent's account in again after an auth refusal: only Codex has a login command for it. */
const RELOGIN_HINT: Partial<Record<SessionAgent, (login: string | undefined) => string>> = {
    codex: (login) =>
        login
            ? `Log in again: ${toolCommand("codex login", login)}.`
            : "Log in again with `codex login`: this account reads the Codex CLI's own auth.json.",
};

/** The readable text: agent, account, model, upstream status and code, reset time, and what to do. */
export function failureText(failure: UpstreamFailure, context: FailureContext, now = Date.now()): string {
    const upstream = `upstream ${failure.status === 200 ? "stream" : failure.status}${failure.code ? ` ${failure.code}` : ""}`;
    const parts = [
        `${AGENT_LABEL[context.agent]} account ${context.account} ${WHAT[failure.kind]} (${context.model}, ${upstream}).`,
    ];

    if (context.tried && context.tried.length > 1) {
        parts.push(`Failover tried ${context.tried.join(", ")}.`);
    }

    if (failure.message) {
        parts.push(`Upstream: "${failure.message.slice(0, 300)}".`);
    }

    if (failure.resetsAtMs) {
        const left = failure.resetsAtMs - now;
        parts.push(
            `It resets at ${formatDateTime(failure.resetsAtMs)}${left > 0 ? ` (in ${formatDuration(left, "ms", "tiered")})` : ""}.`
        );
    } else if (failure.kind === "rate-limit" && failure.retryAfterSec != null) {
        parts.push(`Retry after ${failure.retryAfterSec}s.`);
    }

    if (failure.kind === "overloaded") {
        return parts.join(" ");
    }

    const relogin = RELOGIN_HINT[context.agent];

    if (failure.kind === "auth" && relogin) {
        parts.push(relogin(context.login));
    }

    if (context.sessionId) {
        parts.push(
            `Switch this session to another account: ${toolCommand("ai-proxy session", context.sessionId, "use", `--${context.agent}`, "<account>")} (without --${context.agent} it lists them).`
        );
    } else if (!context.failover) {
        parts.push(
            `Use another account, or let this one fail over: ${toolCommand("ai-proxy accounts failover", context.proxyAccount, "on")}.`
        );
    }

    return parts.join(" ");
}

const OPENAI_TYPE: Record<UpstreamFailureKind, string> = {
    "usage-limit": "rate_limit_error",
    plan: "invalid_request_error",
    "rate-limit": "rate_limit_error",
    auth: "authentication_error",
    overloaded: "server_error",
};

/**
 * The failure as an OpenAI error envelope at `status`: the Anthropic route re-wraps it (`toAnthropicErrorResponse`)
 * and keeps the status, the OpenAI endpoints send it as is.
 */
export function failureResponse(failure: UpstreamFailure, text: string, status: number): Response {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (status === 429 && failure.retryAfterSec != null) {
        headers["Retry-After"] = String(failure.retryAfterSec);
    }

    return new Response(
        SafeJSON.stringify({
            error: { message: text, type: OPENAI_TYPE[failure.kind], code: failure.code ?? failure.kind },
        }),
        { status, headers }
    );
}

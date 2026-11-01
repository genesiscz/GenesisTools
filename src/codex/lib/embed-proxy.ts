import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { VAULT_UNLOCK_TIMEOUT_MS } from "@genesiscz/utils/security/keyring/app-gate";
import type { CodexAccountBinding } from "./account";
import { ACCOUNT_BOUND_ERROR_CODE, ACCOUNT_BOUND_REFUSAL, breaksAccountBinding } from "./account-bound";

/** The account the proxy logs the app-server in as. `authenticate` sends the one `account/login/start`. */
export interface EmbedProxyAccount extends Pick<CodexAccountBinding, "authenticate" | "refresh"> {
    /**
     * Resolves once the account's tokens are in hand. A vault read can wait for the user at the approval window, so it
     * has its own deadline, and the login's short timer starts only after it.
     */
    credentials?(): Promise<unknown>;
}

/** Every request the proxy itself sends carries this id prefix, so its response is recognised and hidden. */
export const EMBED_REQUEST_PREFIX = "genesis-tools-embed:";

const REFRESH_METHOD = "account/chatgptAuthTokens/refresh";

/** Codex answers the external-token login in well under a second; a login still pending after this is a failure. */
export const EMBED_LOGIN_TIMEOUT_MS = 25_000;

/**
 * How long the tokens may take. The app bounds the vault approval at `VAULT_UNLOCK_TIMEOUT_MS`, the wait for another
 * instance's open window included; the minute on top covers the keychain read and a token refresh.
 */
export const EMBED_CREDENTIALS_TIMEOUT_MS = VAULT_UNLOCK_TIMEOUT_MS + 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Splits a byte stream into lines, each with its own `\n`. It works on bytes, not text, so a line passes on byte for
 * byte even when a chunk ends inside a multi-byte character.
 */
export class LineSplitter {
    private pending: Uint8Array[] = [];

    push(chunk: Uint8Array): Uint8Array[] {
        const lines: Uint8Array[] = [];
        let start = 0;
        let newline = chunk.indexOf(0x0a, start);

        while (newline !== -1) {
            lines.push(this.take(chunk.subarray(start, newline + 1)));
            start = newline + 1;
            newline = chunk.indexOf(0x0a, start);
        }

        if (start < chunk.length) {
            this.pending.push(chunk.slice(start));
        }

        return lines;
    }

    /** What is left after the stream ended without a final newline. */
    flush(): Uint8Array | undefined {
        if (this.pending.length === 0) {
            return undefined;
        }

        return this.take(new Uint8Array(0));
    }

    private take(tail: Uint8Array): Uint8Array {
        if (this.pending.length === 0) {
            return tail;
        }

        const parts = [...this.pending, tail];
        const line = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
        let offset = 0;

        for (const part of parts) {
            line.set(part, offset);
            offset += part.length;
        }

        this.pending = [];
        return line;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = SafeJSON.parse(text, { strict: true });

        return isRecord(value) ? value : undefined;
    } catch (error) {
        logger.debug({ error }, "[codex-embed] line is not JSON; passed on unchanged");
        return undefined;
    }
}

function encodeMessage(message: Record<string, unknown>): Uint8Array {
    return encoder.encode(`${SafeJSON.stringify(message, { jsonl: true })}\n`);
}

function responseError(value: unknown): Error {
    if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
        return new Error(value.message);
    }

    return new Error("Codex app-server refused the request");
}

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

type ProxyState = "waiting" | "logging-in" | "ready" | "failed";

export interface CodexEmbedProxyOptions {
    account: EmbedProxyAccount;
    /** Bytes for the app-server's stdin. */
    toChild(bytes: Uint8Array): void;
    /** Closes the app-server's stdin. */
    endChild(): void;
    /** Bytes for the host's stdout. */
    toHost(bytes: Uint8Array): void;
    /** The login failed or timed out; the caller stops the app-server. */
    onLoginFailed(error: Error): void;
    /** From the moment the credentials are ready to the login's answer. */
    loginTimeoutMs?: number;
    /** For `account.credentials()`. */
    credentialsTimeoutMs?: number;
}

/** `work`, or a rejection with `message` once `ms` have passed. The timer never outlives the race. */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });

    try {
        return await Promise.race([work, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The JSON-RPC line proxy between an embedding host (T3 Code) and `codex app-server`.
 *
 * The host's `initialized` notification passes on, and right behind it the proxy sends one `account/login/start` with
 * the account's external tokens. Host lines that arrive while that login runs wait in order, so the host's first
 * `account/read` already sees the account. The login's response and the app-server's token refresh requests are the
 * proxy's own and never reach the host. A host request that would change the account (a login, a logout, a
 * configuration write, another model provider: `breaksAccountBinding`) gets an RPC error and never reaches the
 * app-server, as in the account-bound terminal. Every other line passes on byte for byte, in both directions.
 */
export class CodexEmbedProxy {
    private state: ProxyState = "waiting";
    private queued: Uint8Array[] = [];
    private hostEnded = false;
    private nextId = 1;
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly options: CodexEmbedProxyOptions) {}

    hostLine(line: Uint8Array): void {
        const message = parseObject(decoder.decode(line));

        if (message && this.refuseIdentityChange(message)) {
            return;
        }

        if (this.state === "logging-in") {
            this.queued.push(line);
            return;
        }

        this.options.toChild(line);

        if (this.state === "waiting" && message?.method === "initialized" && !("id" in message)) {
            this.state = "logging-in";
            void this.login();
        }
    }

    /** The host closed its stdin. Lines held back for the login still go first. */
    hostEnd(): void {
        this.hostEnded = true;

        if (this.state !== "logging-in") {
            this.options.endChild();
        }
    }

    childLine(line: Uint8Array): void {
        const text = decoder.decode(line);

        if (text.includes(EMBED_REQUEST_PREFIX) && this.settle(text)) {
            return;
        }

        if (text.includes(REFRESH_METHOD) && this.answerRefresh(text)) {
            return;
        }

        this.options.toHost(line);
    }

    /**
     * True when the host's line was a request that would change the bound account. It is answered with an RPC error
     * (a notification is dropped) and never reaches the app-server, whatever state the login is in. Every line is
     * parsed for this, because a key spelled with a JSON escape (`model\u005fprovider`) slips past a text check.
     */
    private refuseIdentityChange(message: Record<string, unknown>): boolean {
        const { id, method, params } = message;

        if (typeof method !== "string" || !breaksAccountBinding(method, params)) {
            return false;
        }

        logger.warn({ method }, "[codex-embed] refused a host request that would change the account");

        if (id !== undefined) {
            this.options.toHost(
                encodeMessage({ id, error: { code: ACCOUNT_BOUND_ERROR_CODE, message: ACCOUNT_BOUND_REFUSAL } })
            );
        }

        return true;
    }

    private async login(): Promise<void> {
        try {
            const credentials = this.options.account.credentials?.();

            if (credentials) {
                await withDeadline(
                    credentials,
                    this.options.credentialsTimeoutMs ?? EMBED_CREDENTIALS_TIMEOUT_MS,
                    "The account's tokens were not ready in time"
                );
            }

            await withDeadline(
                this.options.account.authenticate({ request: (m, p) => this.request(m, p) }),
                this.options.loginTimeoutMs ?? EMBED_LOGIN_TIMEOUT_MS,
                "Codex app-server did not answer the account login in time"
            );
            logger.info("[codex-embed] account login accepted");
            this.state = "ready";
        } catch (error) {
            this.state = "failed";
            this.queued = [];
            this.options.onLoginFailed(error instanceof Error ? error : new Error(String(error)));
            return;
        }

        const held = this.queued;

        this.queued = [];

        for (const line of held) {
            this.options.toChild(line);
        }

        if (this.hostEnded) {
            this.options.endChild();
        }
    }

    private request<T>(method: string, params?: unknown): Promise<T> {
        const id = `${EMBED_REQUEST_PREFIX}${this.nextId}`;

        this.nextId += 1;
        const result = new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
        });
        this.options.toChild(encodeMessage({ id, method, ...(params === undefined ? {} : { params }) }));
        return result;
    }

    /** True when the line answered one of the proxy's own requests. */
    private settle(text: string): boolean {
        const message = parseObject(text);
        const id = message?.id;

        if (!message || typeof id !== "string" || "method" in message) {
            return false;
        }

        const pending = this.pending.get(id);

        if (!pending) {
            return false;
        }

        this.pending.delete(id);

        if ("error" in message) {
            pending.reject(responseError(message.error));
        } else {
            pending.resolve(message.result);
        }

        return true;
    }

    /** True when the line was the app-server asking for fresh tokens; the vault answers, never the host. */
    private answerRefresh(text: string): boolean {
        const message = parseObject(text);
        const id = message?.id;

        if (!message || message.method !== REFRESH_METHOD || (typeof id !== "string" && typeof id !== "number")) {
            return false;
        }

        const params = message.params;
        const previous =
            typeof params === "object" && params !== null && "previousAccountId" in params
                ? params.previousAccountId
                : null;

        this.options.account
            .refresh(typeof previous === "string" ? previous : null)
            .then((result) => {
                logger.info("[codex-embed] token refresh answered");
                this.options.toChild(encodeMessage({ id, result }));
            })
            .catch((error: unknown) => {
                logger.warn({ error }, "[codex-embed] token refresh failed");
                const reason = error instanceof Error ? error.message : String(error);
                this.options.toChild(encodeMessage({ id, error: { code: -32_000, message: reason } }));
            });

        return true;
    }
}

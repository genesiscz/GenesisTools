import { logger } from "@genesiscz/utils/logger";
import type { AppServerClient, RpcNotification, RpcServerRequest } from "./app-server-client";

const identityKeys = new Set([
    "model_provider",
    "model_providers",
    "chatgpt_base_url",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
    "cli_auth_credentials_store",
    "auth",
    "api_key",
    "experimental_bearer_token",
]);
function changesIdentity(value: unknown): boolean {
    if (Array.isArray(value)) {
        // A list is a legitimate place to hide `{model_provider: …}`, so descend into it
        // rather than treating every array as inert.
        return value.some((child) => changesIdentity(child));
    }

    if (!record(value)) {
        return false;
    }

    return Object.entries(value).some(([key, child]) =>
        key === "modelProvider"
            ? child != null && child !== "openai"
            : identityKeys.has(key.split(".")[0]) || changesIdentity(child)
    );
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapt the native TUI's connection to the already initialized, account-bound client. */
export class CodexTuiBridge {
    private initialized?: Record<string, unknown>;
    private connected = true;
    private nextRequest = 1;
    private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    constructor(
        private readonly options: {
            client: AppServerClient;
            send: (message: Record<string, unknown>) => void;
        }
    ) {}

    ready(initialized: Record<string, unknown>): void {
        this.initialized = initialized;
    }

    /**
     * The terminal server admits a replacement peer on the SAME bridge after a socket drops, and
     * `disconnect()` is one-way. Without this, the new socket opened, then met the account-bound
     * rejection on its own `initialize` and never received a notification.
     */
    connect(): void {
        this.connected = true;
    }

    notification(notification: RpcNotification): void {
        if (this.connected && this.initialized) {
            this.options.send({ method: notification.method, params: notification.params });
        }
    }

    serverRequest(request: RpcServerRequest): Promise<unknown> {
        if (!this.connected || !this.initialized) {
            return Promise.reject(new Error("Codex terminal is disconnected"));
        }

        const id = `gt-server-${this.nextRequest++}`;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.options.send({ id, method: request.method, params: request.params });
        });
    }

    disconnect(): void {
        this.connected = false;
        for (const pending of this.pending.values()) {
            pending.reject(new Error("Codex terminal disconnected"));
        }
        this.pending.clear();
    }

    async receive(message: unknown): Promise<void> {
        if (!record(message)) {
            throw new Error("Invalid Codex client message");
        }

        const { id, method, params } = message;
        if (typeof method !== "string") {
            const pending = typeof id === "string" ? this.pending.get(id) : undefined;
            if (!pending) {
                throw new Error("Unexpected Codex client response");
            }

            this.pending.delete(String(id));
            if ("error" in message) {
                pending.reject(new Error("Codex terminal rejected the server request"));
            } else {
                pending.resolve(message.result);
            }

            return;
        }

        if (
            !this.connected ||
            !this.initialized ||
            method.startsWith("account/login") ||
            method === "account/logout" ||
            (method.startsWith("config/") && !method.endsWith("/read")) ||
            changesIdentity(params)
        ) {
            if (id !== undefined) {
                this.options.send({
                    id,
                    error: {
                        code: -32600,
                        message:
                            "This Codex server is bound to its selected account; login and configuration writes are unavailable",
                    },
                });
            }

            return;
        }

        if (id === undefined) {
            if (method !== "initialized") {
                await this.options.client.notify(method, params);
            }

            return;
        }

        try {
            const result =
                method === "initialize" ? this.initialized : await this.options.client.request(method, params);
            this.options.send({ id, result });
        } catch (error) {
            logger.warn({ method, error }, "Codex terminal request failed");
            this.options.send({ id, error: { code: -32000, message: `Codex request failed: ${method}` } });
        }
    }
}

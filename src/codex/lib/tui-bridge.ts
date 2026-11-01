import { logger } from "@genesiscz/utils/logger";
import { ACCOUNT_BOUND_ERROR_CODE, ACCOUNT_BOUND_REFUSAL, breaksAccountBinding } from "./account-bound";
import type { AppServerClient, RpcNotification, RpcServerRequest } from "./app-server-client";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where a relayed message goes. A response belongs to the peer that asked for it; a server-initiated
 * request goes to the primary TUI, because two peers answering one request is a protocol error; a
 * notification goes to every peer, so a second window is not left blind.
 */
export type PeerTarget = { kind: "peer"; peer: unknown } | { kind: "primary" } | { kind: "broadcast" };

/** Adapt the native TUI's connection to the already initialized, account-bound client. */
export class CodexTuiBridge {
    private initialized?: Record<string, unknown>;
    private connected = true;
    private nextRequest = 1;
    private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

    constructor(
        private readonly options: {
            client: AppServerClient;
            send: (message: Record<string, unknown>, target: PeerTarget) => void;
            /** A request the app-server refused. Reported by the launcher, not printed over the TUI. */
            onRequestFailed?: (failure: { method: string; error: Error }) => void;
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
            this.options.send({ method: notification.method, params: notification.params }, { kind: "broadcast" });
        }
    }

    serverRequest(request: RpcServerRequest): Promise<unknown> {
        if (!this.connected || !this.initialized) {
            return Promise.reject(new Error("Codex terminal is disconnected"));
        }

        const id = `gt-server-${this.nextRequest++}`;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.options.send({ id, method: request.method, params: request.params }, { kind: "primary" });
        });
    }

    /**
     * Settle every in-flight server request without tearing the relay down.
     *
     * A server request is addressed to ONE peer (`{kind: "primary"}`) and its id was issued to
     * that socket. When the primary drops while another peer is still connected — the TUI closing
     * while its own session picker stays open — the relay survives, `primary` moves to the picker,
     * and `disconnect()` never runs. The replacement never saw those requests, so no response can
     * ever match their ids: without this the awaiting caller hangs forever.
     */
    failPending(reason: string): void {
        for (const pending of this.pending.values()) {
            pending.reject(new Error(reason));
        }
        this.pending.clear();
    }

    disconnect(): void {
        this.connected = false;
        this.failPending("Codex terminal disconnected");
    }

    async receive(message: unknown, peer?: unknown): Promise<void> {
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

        if (!this.connected || !this.initialized || breaksAccountBinding(method, params)) {
            if (id !== undefined) {
                this.options.send(
                    { id, error: { code: ACCOUNT_BOUND_ERROR_CODE, message: ACCOUNT_BOUND_REFUSAL } },
                    { kind: "peer", peer }
                );
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
            this.options.send({ id, result }, { kind: "peer", peer });
        } catch (error) {
            // The native TUI owns the screen here, so a console warn lands in the middle of it and
            // shreds the layout. The file log keeps it; the launcher reports it once the TUI exits.
            logger.debug({ method, error }, "Codex terminal request failed");
            this.options.onRequestFailed?.({
                method,
                error: error instanceof Error ? error : new Error(String(error)),
            });
            this.options.send(
                { id, error: { code: -32000, message: `Codex request failed: ${method}` } },
                {
                    kind: "peer",
                    peer,
                }
            );
        }
    }
}

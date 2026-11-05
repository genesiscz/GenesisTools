import { logger } from "@genesiscz/utils/logger";
import type { Socket } from "bun";
import { JSON_RPC_ERRORS, RpcError } from "./errors";
import { type RpcCallContext, type RpcIncoming, RpcPeer, type RpcRequestOptions } from "./peer";

export interface RpcNotification {
    method: string;
    params: unknown;
}

export interface RpcSocketClientOptions {
    socket: string;
    /** The logger scope and the name in its lines. */
    logScope: string;
    label: string;
    /** The reason a call fails with after the server closed the connection. */
    closedMessage?: string;
    /** Answers the server's requests (a host answers `render.still`); without it they are refused as unknown. */
    onRequest?: (incoming: RpcIncoming, context: RpcCallContext) => Promise<unknown>;
    defaultTimeoutMs?: number;
}

/**
 * A JSON-RPC 2.0 client on a Unix socket, one message per line. It calls the server, hears its notifications, and,
 * given `onRequest`, answers requests the server sends it over the same connection.
 */
export class RpcSocketClient {
    private readonly listeners = new Set<(notification: RpcNotification) => void>();
    private readonly closeListeners = new Set<(reason: string) => void>();
    private socket?: Socket<undefined>;

    private constructor(private readonly peer: RpcPeer) {}

    /** Throws when the socket does not answer. */
    static async connect(options: RpcSocketClientOptions): Promise<RpcSocketClient> {
        const { log } = logger.scoped(options.logScope);
        let client: RpcSocketClient | undefined;
        const peer = new RpcPeer({
            write: (bytes) => client?.socket?.write(bytes) ?? 0,
            invalid: "ignore",
            log,
            label: options.label,
            defaultTimeoutMs: options.defaultTimeoutMs,
            onNotification: (notification) => client?.deliver(notification),
            handle: async (incoming, context) => {
                if (!options.onRequest) {
                    throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `unknown method ${incoming.method}`);
                }

                return options.onRequest(incoming, context);
            },
        });
        client = new RpcSocketClient(peer);
        const opened = client;
        opened.socket = await Bun.connect({
            unix: options.socket,
            socket: {
                data: (_socket, chunk) => peer.receive(chunk),
                drain: () => peer.flush(),
                close: () => opened.end(options.closedMessage ?? `the ${options.label} closed the connection`),
                error: (_socket, error) => opened.end(error.message),
            },
        });
        return opened;
    }

    get closed(): boolean {
        return this.peer.closed;
    }

    /** One call; an error reply rejects with an RpcError that carries its code. */
    call<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T> {
        return this.peer.request<T>(method, params, options);
    }

    notify(method: string, params?: unknown): void {
        this.peer.notify(method, params);
    }

    /** Hears every notification from now on; the returned function stops it. */
    onNotification(listener: (notification: RpcNotification) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onClose(listener: (reason: string) => void): void {
        this.closeListeners.add(listener);
    }

    close(): void {
        this.socket?.end();
        this.end("closed");
    }

    private deliver(notification: RpcNotification): void {
        for (const listener of this.listeners) {
            listener(notification);
        }
    }

    private end(reason: string): void {
        if (this.peer.closed) {
            return;
        }

        this.peer.close(reason);

        for (const listener of this.closeListeners) {
            listener(reason);
        }
    }
}

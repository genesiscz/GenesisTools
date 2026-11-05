import { logger } from "@genesiscz/utils/logger";
import type { Socket } from "bun";
import { z } from "zod";
import { type RpcCallContext, RpcPeer, type RpcProgress, type RpcRequestOptions } from "./peer";

/** One client of the server, with the state the service keeps for it (the role its `hello` named). */
export interface RpcConnection<S> {
    state: S;
    /** The events it subscribed to (empty: all of them); undefined until it calls `subscribe`. */
    readonly events?: ReadonlySet<string>;
    readonly closed: boolean;
    /** A request to this client; its reply resolves it. */
    request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
    notify(method: string, params?: unknown): void;
}

export interface RpcCall<S> {
    method: string;
    params: unknown;
    /** The caller's request id; undefined for a notification. */
    id?: string | number | null;
    connection: RpcConnection<S>;
    context: RpcCallContext;
}

export interface RpcSocketServerOptions<S> {
    /** The Unix socket path; the caller makes sure no live owner holds it. */
    socket: string;
    /** The state of a new connection. */
    state: () => S;
    /** Answers every method but `subscribe`, which the server answers itself; throw an RpcError to refuse. */
    call: (call: RpcCall<S>) => Promise<unknown>;
    onOpen?: (connection: RpcConnection<S>) => void;
    onClose?: (connection: RpcConnection<S>) => void;
    /** The logger scope (`live-recordings`) and the name in its lines (`live recording`). */
    logScope: string;
    label: string;
    logFields?: Record<string, unknown>;
}

class Connection<S> implements RpcConnection<S> {
    events?: Set<string>;
    readonly peer: RpcPeer;

    constructor(
        readonly socket: Socket<Connection<S>>,
        public state: S,
        options: {
            log: ReturnType<typeof logger.scoped>["log"];
            label: string;
            logFields?: Record<string, unknown>;
            call: (connection: Connection<S>, call: Omit<RpcCall<S>, "connection">) => Promise<unknown>;
        }
    ) {
        this.peer = new RpcPeer({
            write: (bytes) => socket.write(bytes),
            // A subscriber that stopped reading is disconnected; the recording or service it watched goes on.
            onBacklogFull: () => socket.end(),
            invalid: "answer",
            log: options.log,
            label: options.label,
            logFields: options.logFields,
            handle: (incoming, context) =>
                options.call(this, {
                    method: incoming.method,
                    params: incoming.params,
                    ...(incoming.id !== undefined ? { id: incoming.id } : {}),
                    context,
                }),
        });
    }

    get closed(): boolean {
        return this.peer.closed;
    }

    request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T> {
        return this.peer.request<T>(method, params, options);
    }

    notify(method: string, params?: unknown): void {
        this.peer.notify(method, params);
    }
}

const subscribeParams = z.object({ events: z.array(z.string()).optional() });

/**
 * A JSON-RPC 2.0 server on a Unix socket, one message per line, in both directions: it answers each client's requests
 * in their order, sends notifications to the clients that subscribed, and can send a client a request of its own and
 * await the reply. The live recordings and the recorder service run on it.
 */
export class RpcSocketServer<S> {
    private readonly listener: ReturnType<typeof Bun.listen<Connection<S>>>;
    private readonly open = new Set<Connection<S>>();
    private readonly log: ReturnType<typeof logger.scoped>["log"];

    constructor(private readonly options: RpcSocketServerOptions<S>) {
        this.log = logger.scoped(options.logScope).log;
        const peerOptions = {
            log: this.log,
            label: options.label,
            logFields: options.logFields,
            call: (connection: Connection<S>, call: Omit<RpcCall<S>, "connection">) => this.answer(connection, call),
        };
        this.listener = Bun.listen<Connection<S>>({
            unix: options.socket,
            socket: {
                open: (socket) => {
                    socket.data = new Connection(socket, options.state(), peerOptions);
                    this.open.add(socket.data);
                    options.onOpen?.(socket.data);
                },
                data: (socket, chunk) => {
                    try {
                        socket.data.peer.receive(chunk);
                    } catch (error) {
                        this.forget(socket.data, error instanceof Error ? error.message : String(error));
                        socket.end();
                    }
                },
                drain: (socket) => socket.data.peer.flush(),
                close: (socket) => this.forget(socket.data, "the connection closed"),
                error: (socket, error) => {
                    this.log.debug({ error }, `${options.label} connection error`);
                    this.forget(socket.data, error.message);
                },
            },
        });
    }

    /** The clients connected now. */
    get connections(): readonly RpcConnection<S>[] {
        return [...this.open];
    }

    /** A notification to every connection that subscribed to `event` (and passes `to`, when given). */
    emit(event: string, params: Record<string, unknown>, to?: (connection: RpcConnection<S>) => boolean): void {
        for (const connection of this.open) {
            const wanted = connection.events;

            if (wanted && (wanted.size === 0 || wanted.has(event)) && (!to || to(connection))) {
                connection.notify(event, params);
            }
        }
    }

    /** Ends every connection after its last answer; answers already written go out first. */
    endConnections(): void {
        for (const connection of this.open) {
            void connection.peer.queue
                .then(() => {
                    connection.peer.flush();
                    connection.socket.end();
                })
                .catch((error: unknown) => {
                    this.log.debug({ error }, `${this.options.label} connection ended during shutdown`);
                    connection.socket.end();
                });
        }
    }

    /** Stops accepting connections. Bun removes no socket file; the caller does. */
    stopListening(): void {
        this.listener.stop();
    }

    private forget(connection: Connection<S>, reason: string): void {
        if (!this.open.delete(connection)) {
            return;
        }

        connection.peer.close(reason);
        this.options.onClose?.(connection);
    }

    private async answer(connection: Connection<S>, call: Omit<RpcCall<S>, "connection">): Promise<unknown> {
        if (call.method === "subscribe") {
            const events = subscribeParams.safeParse(call.params ?? {});
            connection.events = new Set(events.success ? (events.data.events ?? []) : []);
            return { events: [...connection.events] };
        }

        return this.options.call({ ...call, connection });
    }
}

export type { RpcCallContext, RpcProgress, RpcRequestOptions };

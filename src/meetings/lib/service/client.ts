import { dirname } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { JSON_RPC_ERRORS, RPC_CANCELLED, RpcError } from "@genesiscz/utils/rpc/errors";
import { readLiveServiceEntry, type ServiceEntry } from "@genesiscz/utils/rpc/service-entry";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import {
    MEETINGS_EVENTS,
    MEETINGS_METHODS,
    MEETINGS_PROTOCOL,
    type MeetingsEvent,
    type MeetingsHello,
    type MeetingsMethod,
    type MeetingsParams,
    type MeetingsResult,
    type MeetingsRole,
    meetingsCodeStamp,
    meetingsMethod,
    meetingsProtocolVersion,
    SUBSCRIBE,
    subscribeParamsSchema,
    UNSUBSCRIBE,
} from "./api";
import {
    asRefusal,
    clientError,
    type MeetingsCallContext,
    type MeetingsHandlerDeps,
    meetingsTable,
    refusalCode,
} from "./handlers";

const { log } = logger.scoped("meetings-client");

/**
 * What a `tools meetings` command, the REPL or an agent calls: the Meetings service through one interface with two
 * adapters. `SocketMeetingsClient` talks to a running service; `InProcessMeetingsClient` runs the same handlers in
 * this process, for no service, a sandbox home, a test, or a service of another checkout. Both give the same values
 * and the same errors, so a command prints the same bytes and exit code either way.
 */
export interface MeetingsClient {
    /** Which adapter answers. */
    readonly kind: "socket" | "in-process";
    /**
     * One call; a refusal rejects with the error `clientError` makes (a conflict keeps its class and code). `signal`
     * cancels it (`$/cancel`); `onProgress` hears a long call's progress (a Moment's cut).
     */
    call<M extends MeetingsMethod>(
        method: M,
        params: MeetingsParams<M>,
        options?: MeetingsCallOptions
    ): Promise<MeetingsResult<M>>;
    /** Hears the events of one meeting (or every meeting) until the returned function stops it. */
    subscribe(
        filter: { meeting?: string; events?: readonly MeetingsEvent[] },
        listener: (event: MeetingsEventMessage) => void
    ): Promise<() => void>;
    close(): void;
}

export interface MeetingsCallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (update: { fraction?: number; label?: string }) => void;
}

/** One notification as a listener gets it. */
export interface MeetingsEventMessage {
    method: string;
    params: unknown;
}

/** `<genesis-tools root>/meetings-service`: service.json, the socket and the pid claim (the store's folder is records only). */
export function meetingsServiceDir(): string {
    return toolDataDir("meetings-service");
}

/** A meeting the event names, for the subscription's filter. */
function meetingOf(params: unknown): string | undefined {
    const meeting = typeof params === "object" && params !== null ? Reflect.get(params, "meeting") : undefined;
    return typeof meeting === "string" ? meeting : undefined;
}

/** True when a subscription with this filter hears the event. */
export function subscriptionHears(
    filter: { meeting?: string; events?: readonly string[] },
    event: string,
    params: unknown
): boolean {
    const events = filter.events ?? [];
    return (
        (events.length === 0 || events.includes(event)) &&
        (event === "people.changed" || !filter.meeting || filter.meeting === meetingOf(params))
    );
}

/**
 * The filter as both adapters accept it: an empty or non-string meeting would widen the subscription to every meeting,
 * so it is refused as invalid params (-32602), as the service refuses it.
 */
function checkedFilter<F extends { meeting?: string; events?: readonly string[] }>(filter: F): F {
    // The filter itself, never a copy: a spread would turn a string `events` into its characters, which the schema takes.
    const parsed = subscribeParamsSchema.safeParse(filter);

    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RpcError(
            JSON_RPC_ERRORS.invalidParams,
            `subscribe: ${issue?.path.join(".") || "params"}: ${issue?.message}`
        );
    }

    return filter;
}

/**
 * The events of this process, for the in-process adapter: a write a command makes without a service reaches the
 * subscribers of the same process (the service's own `emit` reaches its connections).
 */
export class LocalMeetingsEvents {
    private readonly listeners = new Set<{
        filter: { meeting?: string; events?: readonly string[] };
        listener: (event: MeetingsEventMessage) => void;
    }>();

    emit(event: MeetingsEvent, params: Record<string, unknown>): void {
        for (const each of this.listeners) {
            if (subscriptionHears(each.filter, event, params)) {
                each.listener({ method: event, params });
            }
        }
    }

    listen(
        filter: { meeting?: string; events?: readonly string[] },
        listener: (event: MeetingsEventMessage) => void
    ): () => void {
        const entry = { filter, listener };
        this.listeners.add(entry);
        return () => this.listeners.delete(entry);
    }
}

/** The process's own event bus. */
export const localMeetingsEvents = new LocalMeetingsEvents();

/** The answer of `hello` for a caller of this code: the in-process adapter's, and the service's when its code matches. */
export function helloAnswer(code = meetingsCodeStamp()): MeetingsResult<"hello"> {
    return {
        protocol: MEETINGS_PROTOCOL,
        code,
        methods: [...MEETINGS_METHODS],
        events: [...MEETINGS_EVENTS],
        version: meetingsProtocolVersion(),
    };
}

/** The same handlers in this process; `hello` sets the caller of later calls. */
export class InProcessMeetingsClient implements MeetingsClient {
    readonly kind = "in-process";
    private readonly table;
    private caller?: MeetingsHello;
    private readonly stops = new Set<() => void>();

    constructor(
        private readonly options: {
            hello?: MeetingsHello;
            deps?: MeetingsHandlerDeps;
            events?: LocalMeetingsEvents;
        } = {}
    ) {
        this.table = meetingsTable(options.deps);
        this.caller = options.hello;
    }

    async call<M extends MeetingsMethod>(
        method: M,
        params: MeetingsParams<M>,
        options: MeetingsCallOptions = {}
    ): Promise<MeetingsResult<M>> {
        // A cancelled call stops before any handler runs, as `RpcPeer.request` stops it on a socket.
        if (options.signal?.aborted) {
            throw clientError(new RpcError(RPC_CANCELLED, `${method}: cancelled`));
        }

        const context: MeetingsCallContext = {
            ...(this.caller ? { caller: this.caller } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onProgress ? { progress: options.onProgress } : {}),
            hello: (hello) => {
                this.caller = hello;
                return helloAnswer();
            },
            local: true,
            emit: (event, params) => (this.options.events ?? localMeetingsEvents).emit(event, params),
        };

        try {
            // The socket's answer is this value as JSON, so a command prints the same bytes from either.
            return (await this.table.call(method, params, context)) as MeetingsResult<M>;
        } catch (error) {
            // As the service answers it (`asRefusal`), then as the socket adapter throws it.
            throw clientError(asRefusal(error));
        }
    }

    async subscribe(
        filter: { meeting?: string; events?: readonly MeetingsEvent[] },
        listener: (event: MeetingsEventMessage) => void
    ): Promise<() => void> {
        const stop = (this.options.events ?? localMeetingsEvents).listen(checkedFilter(filter), listener);
        this.stops.add(stop);
        return () => {
            this.stops.delete(stop);
            stop();
        };
    }

    close(): void {
        for (const stop of this.stops) {
            stop();
        }

        this.stops.clear();
    }
}

/** A connection to the service `entry` names, greeted with `hello`; throws when it does not answer or refuses. */
async function greetedConnection(entry: ServiceEntry, hello: MeetingsHello): Promise<RpcSocketClient> {
    const client = await RpcSocketClient.connect({
        socket: entry.socket,
        logScope: "meetings-client",
        label: "meetings service",
    });

    try {
        await client.call("hello", hello, { timeoutMs: 5_000 });
        return client;
    } catch (error) {
        client.close();
        throw error;
    }
}

/**
 * A connection to the running service, greeted with `hello`. A closed connection proves only that this client lost
 * it, not that the service stopped: the next call connects again to a live service of the same code (its listeners'
 * subscription restored), and answers in this process only when no service runs.
 */
export class SocketMeetingsClient implements MeetingsClient {
    readonly kind = "socket";
    private readonly listeners = new Set<{
        filter: { meeting?: string; events?: readonly string[] };
        listener: (event: MeetingsEventMessage) => void;
    }>();

    private fallback?: InProcessMeetingsClient;
    /** Stops this process's event bus reaching the listeners; set while calls answer in this process. */
    private stopLocal?: () => void;
    private ended = false;
    /** The connect in flight: every call that finds the connection closed waits on this one, never a second socket. */
    private reconnecting?: Promise<boolean>;

    private constructor(
        private client: RpcSocketClient,
        private readonly hello: MeetingsHello,
        private entry: ServiceEntry
    ) {
        this.attach(client);
    }

    /** Connects and says hello; throws when the socket does not answer or the service refuses the hello. */
    static async connect(entry: ServiceEntry, hello: MeetingsHello): Promise<SocketMeetingsClient> {
        return new SocketMeetingsClient(await greetedConnection(entry, hello), hello, entry);
    }

    async call<M extends MeetingsMethod>(
        method: M,
        params: MeetingsParams<M>,
        options: MeetingsCallOptions = {}
    ): Promise<MeetingsResult<M>> {
        // The connection went before this call left (the service stopped for a code change while a listen round
        // waited): nothing reached the service, so the call goes to a live one again, or answers without it.
        if (this.client.closed && !(await this.reconnect())) {
            return this.withoutService(method, params, options);
        }

        try {
            return await this.client.call<MeetingsResult<M>>(method, params, options);
        } catch (error) {
            // The connection went (the service stopped for a code change between the hello and this call): a read
            // answers in this process, as it would have with no service. A write may have reached it, so it throws.
            if (!(error instanceof RpcError) && meetingsMethod(method).effect === "read") {
                log.debug({ error, method }, "the meetings service went during a read");
                return this.withoutService(method, params, options);
            }

            throw clientError(error);
        }
    }

    private inProcess(): InProcessMeetingsClient {
        this.fallback ??= new InProcessMeetingsClient({ hello: this.hello });
        return this.fallback;
    }

    async subscribe(
        filter: { meeting?: string; events?: readonly MeetingsEvent[] },
        listener: (event: MeetingsEventMessage) => void
    ): Promise<() => void> {
        const entry = { filter: checkedFilter(filter), listener };
        this.listeners.add(entry);

        // One subscription per connection on the service: the union of the listeners' events and meetings. A connect
        // that another call started may have sent its filter before this listener joined, so it is sent again.
        if (this.client.closed && !(await this.reconnect())) {
            this.listenInProcess();
        } else {
            await this.resubscribe();
        }

        return () => {
            this.listeners.delete(entry);

            if (this.client.closed) {
                return;
            }

            void this.resubscribe().catch((error: unknown) => {
                log.debug({ error }, "a meetings unsubscribe found the connection closed");
            });
        };
    }

    close(): void {
        this.ended = true;
        this.listeners.clear();
        this.stopLocal?.();
        this.fallback?.close();
        this.client.close();
    }

    private attach(client: RpcSocketClient): void {
        this.client = client;
        client.onNotification((notification) => this.deliver(notification));
    }

    private deliver(event: MeetingsEventMessage): void {
        for (const each of this.listeners) {
            if (subscriptionHears(each.filter, event.method, event.params)) {
                each.listener(event);
            }
        }
    }

    /** The folder of the service's service.json: the meetings service listens on `<dir>/service.sock`. */
    private serviceDir(): string {
        return dirname(this.entry.socket);
    }

    /**
     * A new connection after the last one closed, when the folder names a live service of this protocol and code (as
     * `openMeetingsClient` would take it); the listeners' subscription is restored on it. False when no such service
     * runs or it refuses this caller. Calls that find the connection closed together share one connect.
     */
    private reconnect(): Promise<boolean> {
        if (!this.reconnecting) {
            this.reconnecting = this.connectAgain().finally(() => {
                this.reconnecting = undefined;
            });
        }

        return this.reconnecting;
    }

    private async connectAgain(): Promise<boolean> {
        if (this.ended) {
            return false;
        }

        if (!this.client.closed) {
            return true;
        }

        const entry = readLiveServiceEntry(this.serviceDir());

        if (!entry || entry.protocol !== MEETINGS_PROTOCOL || (entry.code && entry.code !== this.hello.code)) {
            return false;
        }

        try {
            const candidate = await greetedConnection(entry, this.hello);

            // close() ran while the hello was out: the new socket belongs to no one.
            if (this.ended) {
                candidate.close();
                return false;
            }

            this.attach(candidate);
            this.entry = entry;

            if (this.listeners.size > 0) {
                await this.resubscribe();
            }
        } catch (error) {
            log.debug({ error, pid: entry.pid }, "the meetings service did not take this caller again");
            return false;
        }

        this.stopLocal?.();
        this.stopLocal = undefined;
        log.debug({ pid: entry.pid }, "connected to the meetings service again");
        return true;
    }

    /**
     * A call with no connection to a service. A read answers in this process. A write does so only once the service is
     * gone, since until then it may still own the store or still run an earlier call; it is refused before then.
     */
    private withoutService<M extends MeetingsMethod>(
        method: M,
        params: MeetingsParams<M>,
        options: MeetingsCallOptions
    ): Promise<MeetingsResult<M>> {
        if (meetingsMethod(method).effect !== "read" && !this.serviceGone()) {
            throw clientError(
                new Error(
                    `${method}: the meetings service closed this connection but has not exited yet; nothing was changed, try again`
                )
            );
        }

        log.debug({ method }, "no meetings service runs; answering in-process");
        this.listenInProcess();
        return this.inProcess().call(method, params, options);
    }

    /** No live service in the folder, and the process this client spoke to has exited. */
    private serviceGone(): boolean {
        if (readLiveServiceEntry(this.serviceDir())) {
            return false;
        }

        // A service in this process removed its entry in the same step that closed its connections.
        if (this.entry.pid === process.pid) {
            return true;
        }

        const status = classifyPid(this.entry.pid, this.entry.pidCommand).status;
        return status === "dead" || status === "foreign";
    }

    /** The in-process adapter emits on this process's event bus, so the listeners hear its writes there. */
    private listenInProcess(): void {
        // A closed client keeps no listener on this process's bus: close() already stopped the last one.
        if (this.ended) {
            return;
        }

        this.stopLocal ??= localMeetingsEvents.listen({}, (event) => this.deliver(event));
    }

    /**
     * The service's filter of this connection: every listener's events, and one meeting only when all name it. With no
     * listener left it unsubscribes: an empty event list would read as every event.
     */
    private async resubscribe(): Promise<void> {
        if (this.listeners.size === 0) {
            await this.client.call(UNSUBSCRIBE, {});
            return;
        }

        const filters = [...this.listeners].map((each) => each.filter);
        const anyEvent = filters.some((filter) => !filter.events || filter.events.length === 0);
        const events = anyEvent ? [] : [...new Set(filters.flatMap((filter) => filter.events ?? []))];
        const meetings = new Set(filters.map((filter) => filter.meeting));
        const meeting = meetings.size === 1 ? [...meetings][0] : undefined;
        await this.client.call(SUBSCRIBE, subscribeParamsSchema.parse({ events, ...(meeting ? { meeting } : {}) }));
    }
}

/** Who this process is, for its `hello`: the agent harness and session from `whoIsCalling`, without any I/O. */
export async function callerHello(role: MeetingsRole): Promise<MeetingsHello> {
    // Loaded only when a service answers: the identity module costs about 35 ms to import.
    const { whoIsCalling } = await import("@genesiscz/utils/agent/identity");
    const identity = whoIsCalling({ origin: "local", env: env.getProcessEnv() });
    return {
        role,
        protocol: MEETINGS_PROTOCOL,
        code: meetingsCodeStamp(),
        pid: process.pid,
        ...(identity.isInAgent && identity.agent !== "unknown" ? { harness: identity.agent } : {}),
        ...(identity.sessionId ? { session: identity.sessionId } : {}),
    };
}

/**
 * The client a command uses: the running service when one runs with this protocol and this checkout's code, else the
 * same handlers in this process. A read never starts the service; a refused or failed connect answers in-process.
 */
export async function openMeetingsClient(
    options: { role?: MeetingsRole; dir?: string; deps?: MeetingsHandlerDeps } = {}
): Promise<MeetingsClient> {
    const role = options.role ?? "cli";
    const entry = readLiveServiceEntry(options.dir ?? meetingsServiceDir());
    // No identity here: nothing in-process records an actor yet (F5's writes read it when they need it).
    const inProcess = () =>
        new InProcessMeetingsClient({
            hello: { role, protocol: MEETINGS_PROTOCOL, code: meetingsCodeStamp(), pid: process.pid },
            deps: options.deps,
        });

    if (!entry || entry.protocol !== MEETINGS_PROTOCOL || (entry.code && entry.code !== meetingsCodeStamp())) {
        return inProcess();
    }

    try {
        return await SocketMeetingsClient.connect(entry, await callerHello(role));
    } catch (error) {
        const code = error instanceof RpcError ? refusalCode(error) : undefined;
        log.debug(
            { error, code, pid: entry.pid },
            "the meetings service did not take this caller; answering in-process"
        );
        return inProcess();
    }
}

/** Opens a client, runs `work` with it and closes it. */
export async function withMeetingsClient<T>(
    work: (client: MeetingsClient) => Promise<T>,
    options: { role?: MeetingsRole; dir?: string; deps?: MeetingsHandlerDeps } = {}
): Promise<T> {
    const client = await openMeetingsClient(options);

    try {
        return await work(client);
    } finally {
        client.close();
    }
}

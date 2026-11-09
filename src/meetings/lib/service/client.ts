import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import { readLiveServiceEntry, type ServiceEntry } from "@genesiscz/utils/rpc/service-host";
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
    /** One call; a refusal rejects with the error `clientError` makes (a conflict keeps its class and code). */
    call<M extends MeetingsMethod>(
        method: M,
        params: MeetingsParams<M>,
        options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<MeetingsResult<M>>;
    /** Hears the events of one meeting (or every meeting) until the returned function stops it. */
    subscribe(
        filter: { meeting?: string; events?: readonly MeetingsEvent[] },
        listener: (event: MeetingsEventMessage) => void
    ): Promise<() => void>;
    close(): void;
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
    return (events.length === 0 || events.includes(event)) && (!filter.meeting || filter.meeting === meetingOf(params));
}

/**
 * The filter as both adapters accept it: an empty or non-string meeting would widen the subscription to every meeting,
 * so it is refused as invalid params (-32602), as the service refuses it.
 */
function checkedFilter<F extends { meeting?: string; events?: readonly string[] }>(filter: F): F {
    const parsed = subscribeParamsSchema.safeParse({
        ...filter,
        ...(filter.events ? { events: [...filter.events] } : {}),
    });

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
        options: { signal?: AbortSignal } = {}
    ): Promise<MeetingsResult<M>> {
        const context: MeetingsCallContext = {
            ...(this.caller ? { caller: this.caller } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            hello: (hello) => {
                this.caller = hello;
                return helloAnswer();
            },
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

/** A connection to the running service, greeted with `hello`. */
export class SocketMeetingsClient implements MeetingsClient {
    readonly kind = "socket";
    private readonly listeners = new Set<{
        filter: { meeting?: string; events?: readonly string[] };
        listener: (event: MeetingsEventMessage) => void;
    }>();

    private fallback?: InProcessMeetingsClient;

    private constructor(
        private readonly client: RpcSocketClient,
        private readonly hello: MeetingsHello
    ) {
        client.onNotification((notification) => {
            for (const each of this.listeners) {
                if (subscriptionHears(each.filter, notification.method, notification.params)) {
                    each.listener(notification);
                }
            }
        });
    }

    /** Connects and says hello; throws when the socket does not answer or the service refuses the hello. */
    static async connect(entry: ServiceEntry, hello: MeetingsHello): Promise<SocketMeetingsClient> {
        const client = await RpcSocketClient.connect({
            socket: entry.socket,
            logScope: "meetings-client",
            label: "meetings service",
        });

        try {
            await client.call("hello", hello, { timeoutMs: 5_000 });
            return new SocketMeetingsClient(client, hello);
        } catch (error) {
            client.close();
            throw error;
        }
    }

    async call<M extends MeetingsMethod>(
        method: M,
        params: MeetingsParams<M>,
        options: { signal?: AbortSignal; timeoutMs?: number } = {}
    ): Promise<MeetingsResult<M>> {
        try {
            return await this.client.call<MeetingsResult<M>>(method, params, options);
        } catch (error) {
            // The connection went (the service stopped for a code change between the hello and this call): a read
            // answers in this process, as it would have with no service.
            if (!(error instanceof RpcError) && meetingsMethod(method).effect === "read") {
                log.debug({ error, method }, "the meetings service went during a read; answering in-process");
                this.fallback ??= new InProcessMeetingsClient({ hello: this.hello });
                return this.fallback.call(method, params, options);
            }

            throw clientError(error);
        }
    }

    async subscribe(
        filter: { meeting?: string; events?: readonly MeetingsEvent[] },
        listener: (event: MeetingsEventMessage) => void
    ): Promise<() => void> {
        const entry = { filter: checkedFilter(filter), listener };
        this.listeners.add(entry);
        // One subscription per connection on the service: the union of the listeners' events and meetings.
        await this.resubscribe();
        return () => {
            this.listeners.delete(entry);
            void this.resubscribe().catch((error: unknown) => {
                log.debug({ error }, "a meetings unsubscribe found the connection closed");
            });
        };
    }

    close(): void {
        this.listeners.clear();
        this.fallback?.close();
        this.client.close();
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

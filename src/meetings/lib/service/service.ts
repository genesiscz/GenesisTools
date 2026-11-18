import type { WatcherOptions } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import type { RpcProgress } from "@genesiscz/utils/rpc/peer";
import { type ServiceEntry, type ServiceHost, startServiceHost } from "@genesiscz/utils/rpc/service-host";
import type { RpcConnection } from "@genesiscz/utils/rpc/socket-server";
import {
    MEETINGS_PROTOCOL,
    type MeetingsEvent,
    type MeetingsHello,
    type MeetingsNotification,
    type MeetingsRole,
    meetingsCodeStamp,
    subscribeParamsSchema,
} from "./api";
import { helloAnswer, meetingsServiceDir } from "./client";
import { MeetingsFolderWatch } from "./folder-watch";
import { asRefusal, type MeetingsHandlerDeps, meetingsTable, refusal } from "./handlers";

const { log } = logger.scoped("meetings-service");

/** The service exits after this long with no connection, as the recorder service does. */
export const MEETINGS_SERVICE_IDLE_MS = 10 * 60_000;

/**
 * How often a running call says again that it works (`progressBeat`). Far under every client's deadline (the window
 * waits 60 s of silence), so a long call ends by its answer and a deadline still catches a service that hangs.
 */
export const MEETINGS_CALL_BEAT_MS = 15_000;

/**
 * A running call's progress with a beat: each step goes out at once, and the newest one again every `everyMs` until
 * `stop` (an empty step before the first one). A client's deadline restarts on each `$/progress`, so it measures how
 * long the service was silent, never how long the work takes. Why (w_gu80y4mc): a suggest with a cold voice pass ran
 * 116 s on a 172-minute meeting, about 400 s at background priority, and its reading phases before the voice pass send
 * no step of their own; the window's fixed deadline failed the call while the service went on working.
 */
export function progressBeat(send: (update: RpcProgress) => void, everyMs: number) {
    let last: RpcProgress = {};
    const timer = everyMs > 0 ? setInterval(() => send(last), everyMs) : undefined;
    timer?.unref?.();
    return {
        progress(update: RpcProgress): void {
            last = update;
            send(update);
        },
        stop(): void {
            if (timer) {
                clearInterval(timer);
            }
        },
    };
}

interface ConnectionState {
    id: number;
    /** Who the connection said it is; every call but `hello` waits for it. */
    hello?: MeetingsHello;
    /** The meeting its subscription names; undefined: every meeting. */
    meeting?: string;
}

export interface MeetingsServiceOptions extends MeetingsHandlerDeps {
    /** The folder of service.json, the socket and the pid claim (`meetingsServiceDir()`). */
    dir?: string;
    /** 0 never exits for idleness. */
    idleMs?: number;
    checkEveryMs?: number;
    /** The checkout whose loaded modules a code change is read from; tests pass none. */
    sourceRoot?: string;
    /** The code stamp it answers and compares (`meetingsCodeStamp()`). */
    code?: string;
    rivalWaitMs?: number;
    onStopped?: (reason: string) => void;
    /** How often a running call repeats its newest step (`MEETINGS_CALL_BEAT_MS`); 0 for no beat. */
    beatMs?: number;
    /**
     * The watch on the meetings folder that tells `meeting.changed` for writes outside the service; on by default,
     * `false` for none (a test that writes its own files), or a fake event source and coalescing time.
     */
    watch?: false | { subscribe?: WatcherOptions["subscribe"]; coalesceMs?: number };
}

/** One connected caller, as the service knows it. */
export interface MeetingsCaller {
    role: MeetingsRole;
    harness?: string;
    session?: string;
    pid?: number;
}

export interface MeetingsService {
    readonly entry: ServiceEntry;
    /** The callers connected now that said hello. */
    callers(): MeetingsCaller[];
    /** A notification to every subscriber of the event and of its meeting. */
    emit<E extends MeetingsEvent>(event: E, params: MeetingsNotification<E>): void;
    stop(reason: string): void;
    readonly stopped: Promise<string>;
}

export type MeetingsServiceStart =
    | { status: "started"; service: MeetingsService }
    | { status: "running"; entry: ServiceEntry };

/**
 * Starts the Meetings service in this process (`tools meetings serve`): the one owner of the meetings store on this
 * Mac while it runs. A second start finds the first and answers `running`.
 */
export async function startMeetingsService(options: MeetingsServiceOptions = {}): Promise<MeetingsServiceStart> {
    const code = options.code ?? meetingsCodeStamp();
    const table = meetingsTable(options);
    let lastId = 0;
    // `host` is set once it listens; no call reaches `hello` before.
    let host: ServiceHost<ConnectionState> | undefined;
    let watch: MeetingsFolderWatch | undefined;

    /** A notification to every connection subscribed to the event and to its meeting (or to every meeting). */
    const emit = <E extends MeetingsEvent>(event: E, params: MeetingsNotification<E>): void => {
        // The event already announces this record write, so the watcher must not announce it again.
        const meeting = "meeting" in params ? params.meeting : undefined;
        if (
            (event === "decision.applied" || event === "decision.reverted" || event === "meeting.changed") &&
            typeof meeting === "string"
        ) {
            watch?.ownWrite(meeting);
        }

        host?.emit(
            event,
            { ...params },
            (connection) =>
                event === "people.changed" || !connection.state.meeting || connection.state.meeting === meeting
        );
    };

    const greet = (connection: RpcConnection<ConnectionState>, hello: MeetingsHello) => {
        if (hello.protocol !== MEETINGS_PROTOCOL) {
            throw refusal(
                "protocol-mismatch",
                `the meetings service speaks protocol ${MEETINGS_PROTOCOL}, not ${hello.protocol}`
            );
        }

        if (hello.code !== undefined && hello.code !== code) {
            throw refusal("code-mismatch", `the meetings service runs the code of another checkout (${code})`);
        }

        // A changed module: this service answers old code, so it refuses and exits once no call runs.
        if (host && !host.codeIsCurrent()) {
            throw refusal("code-mismatch", "the meetings service's code changed since it started; it exits soon");
        }

        connection.state.hello = hello;
        log.debug({ role: hello.role, harness: hello.harness, pid: hello.pid }, "a meetings caller said hello");
        return helloAnswer(code);
    };

    const start = await startServiceHost<ConnectionState>({
        dir: options.dir ?? meetingsServiceDir(),
        label: "meetings service",
        logScope: "meetings-service",
        protocol: MEETINGS_PROTOCOL,
        code,
        state: () => ({ id: ++lastId }),
        call: async ({ method, params, connection, context }) => {
            const beat = progressBeat((update) => context.progress(update), options.beatMs ?? MEETINGS_CALL_BEAT_MS);
            try {
                if (method !== "hello" && !connection.state.hello) {
                    throw refusal("no-hello", `say hello before ${method}`);
                }

                return await table.call(method, params, {
                    ...(connection.state.hello ? { caller: connection.state.hello } : {}),
                    signal: context.signal,
                    hello: (hello) => greet(connection, hello),
                    emit: (event, notification) => emit(event, notification),
                    progress: beat.progress,
                });
            } catch (error) {
                throw asRefusal(error);
            } finally {
                beat.stop();
            }
        },
        onSubscribe: (connection, params) => {
            if (!connection.state.hello) {
                throw refusal("no-hello", "say hello before subscribe");
            }

            const parsed = subscribeParamsSchema.safeParse(params ?? {});

            // An invalid meeting filter would widen the subscription to every meeting; it is refused instead.
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw new RpcError(
                    JSON_RPC_ERRORS.invalidParams,
                    `subscribe: ${issue?.path.join(".") || "params"}: ${issue?.message}`
                );
            }

            connection.state.meeting = parsed.data.meeting;
        },
        idleMs: options.idleMs ?? MEETINGS_SERVICE_IDLE_MS,
        checkEveryMs: options.checkEveryMs,
        sourceRoot: options.sourceRoot,
        rivalWaitMs: options.rivalWaitMs,
        onStopped: options.onStopped,
        // The next row's click cuts its Moment; the older cut it replaces stops at once (G-PLAY-10).
        supersedes: (method) => (method === "moment.clip" ? method : undefined),
    });

    if (start.status === "running") {
        return start;
    }

    host = start.host;
    const listening = start.host;

    if (options.watch !== false) {
        const folderWatch = new MeetingsFolderWatch({
            root: (options.store?.() ?? new MeetingStore()).root,
            emit: (meeting, parts) => emit("meeting.changed", { meeting, parts }),
            peopleChanged: () => emit("people.changed", {}),
            commentsChanged: (meeting) => emit("comment.changed", { meeting }),
            ...(options.watch?.subscribe ? { subscribe: options.watch.subscribe } : {}),
            ...(options.watch?.coalesceMs !== undefined ? { coalesceMs: options.watch.coalesceMs } : {}),
        });

        // A folder that cannot be watched leaves the service without `meeting.changed`, never without the service.
        try {
            await folderWatch.start();
            watch = folderWatch;
            void listening.stopped.then(() => folderWatch.stop());
        } catch (error) {
            log.warn({ error }, "the meetings folder is not watched; outside writes tell no meeting.changed");
        }
    }

    return {
        status: "started",
        service: {
            entry: listening.entry,
            callers: () =>
                listening.connections.flatMap((connection) => {
                    const hello = connection.state.hello;
                    return hello
                        ? [
                              {
                                  role: hello.role,
                                  ...(hello.harness ? { harness: hello.harness } : {}),
                                  ...(hello.session ? { session: hello.session } : {}),
                                  ...(hello.pid ? { pid: hello.pid } : {}),
                              },
                          ]
                        : [];
                }),
            emit,
            stop: listening.stop,
            stopped: listening.stopped,
        },
    };
}

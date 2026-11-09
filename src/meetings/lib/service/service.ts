import { logger } from "@genesiscz/utils/logger";
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
import { asRefusal, type MeetingsHandlerDeps, meetingsTable, refusal } from "./handlers";

const { log } = logger.scoped("meetings-service");

/** The service exits after this long with no connection, as the recorder service does. */
export const MEETINGS_SERVICE_IDLE_MS = 10 * 60_000;

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
            try {
                if (method !== "hello" && !connection.state.hello) {
                    throw refusal("no-hello", `say hello before ${method}`);
                }

                return await table.call(method, params, {
                    ...(connection.state.hello ? { caller: connection.state.hello } : {}),
                    signal: context.signal,
                    hello: (hello) => greet(connection, hello),
                });
            } catch (error) {
                throw asRefusal(error);
            }
        },
        onSubscribe: (connection, params) => {
            const parsed = subscribeParamsSchema.safeParse(params ?? {});
            connection.state.meeting = parsed.success ? parsed.data.meeting : undefined;
        },
        idleMs: options.idleMs ?? MEETINGS_SERVICE_IDLE_MS,
        checkEveryMs: options.checkEveryMs,
        sourceRoot: options.sourceRoot,
        rivalWaitMs: options.rivalWaitMs,
        onStopped: options.onStopped,
    });

    if (start.status === "running") {
        return start;
    }

    host = start.host;
    const listening = start.host;

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
            emit: (event, params) =>
                listening.emit(
                    event,
                    { ...params },
                    (connection) => !connection.state.meeting || connection.state.meeting === params.meeting
                ),
            stop: listening.stop,
            stopped: listening.stopped,
        },
    };
}

import { handleHandlers, toRpcTable } from "@genesiscz/utils/api-descriptor";
import { logger } from "@genesiscz/utils/logger";
import type { EditProject } from "@genesiscz/utils/recording-editor/project";
import type { RpcCallContext } from "@genesiscz/utils/rpc/peer";
import { type ServiceHost, startServiceHost } from "@genesiscz/utils/rpc/service-host";
import type { RpcConnection } from "@genesiscz/utils/rpc/socket-server";
import { RPC_ERRORS, RpcError } from "@genesiscz/utils/screen-recorder/control";
import { callTimeoutFor } from "@genesiscz/utils/screen-recorder/live";
import { RECORDING_EVENT, RECORDINGS_CHANGED } from "@genesiscz/utils/screen-recorder/service-link";
import { z } from "zod";
import { editPathOf, editProject, setEditOwner, withEditCancel } from "./edit";
import {
    type ChangeWriter,
    type EditSession,
    EditSessions,
    type ProjectChanged,
    withEditSession,
} from "./edit-session";
import { ConnectedAppHost, type HeadlessDeps, HeadlessHost, type HostCallContext, type RecorderHost } from "./host";
import { listLibrary } from "./library";
import { searchLibrary } from "./moments";
import { setRecorderHostResolver } from "./service-client";
import {
    HOST_METHODS,
    HOST_SCHEMAS,
    type HostMethod,
    type HostParams,
    type HostResult,
    isHostMethod,
    type LiveRecordingRow,
    protocolVersion,
    type RecordingsChanged,
    recorderServiceDir,
    recordingEventSchema,
    SERVICE_PROTOCOL,
    type ServiceEntry,
    type ServiceRole,
    serviceApi,
    serviceSocketPath,
} from "./service-protocol";
import { Movie, moviesApi } from "./toolset";

const { log } = logger.scoped("recorder-service");

/** The service exits after this long with no connection and no open session. */
export const SERVICE_IDLE_MS = 10 * 60_000;
/** Without a host, a window or camera call starts the app and waits this long for its hello. */
const HOST_WAIT_MS = 10_000;

interface ConnectionState {
    /** Unique in this service: a gesture id a client picks is its own under it. */
    id: number;
    role?: ServiceRole;
    pid?: number;
    /** The edit paths this connection holds sessions of, each with its holders (editor windows); "" is the connection. */
    holds: Map<string, Set<string>>;
    /** The gestures this connection began and has not ended: the session's key of each, to its edit path. */
    gestures: Map<string, string>;
    /** A `recording` connection: the ids of the live recordings it registered. */
    recordings: Set<string>;
}

type Connection = RpcConnection<ConnectionState>;
/** What a service method handler gets beside its params: the caller's connection and its request's context. */
interface HandlerContext {
    connection: Connection;
    context: RpcCallContext;
}

export interface RecorderServiceOptions {
    /** `<recordings>` by default; tests use a scratch folder. */
    dir?: string;
    /** 0 never exits for idleness. */
    idleMs?: number;
    checkEveryMs?: number;
    /** The repo's `src/`: a loaded module under it changed after the start makes the service exit (the hub's rule). */
    sourceRoot?: string;
    saveDelayMs?: number;
    hostWaitMs?: number;
    /** The headless face and `open`; tests stub them, so no app starts there. */
    headless?: Partial<HeadlessDeps>;
    onStopped?: (reason: string) => void;
    /**
     * Builds the native recorder (ax-tool) ahead of a recording when it is stale, without waiting: at the start
     * (`recorder-service-start`) and at each check (`recorder-service-check`, a native source change). `serve` passes
     * `prewarmAxTool`; tests leave it out, so no build starts there.
     */
    prewarmNative?: (trigger: string) => void;
}

export interface RecorderService {
    readonly entry: ServiceEntry;
    readonly sessions: EditSessions;
    /** The live recordings registered now, oldest first. */
    liveRecordings(): LiveRecordingRow[];
    /** The host methods, answered as a client of this process would get them (the connected app or the fallback). */
    readonly host: RecorderHost;
    stop(reason: string): void;
    /** Resolves with the reason once the service stopped. */
    readonly stopped: Promise<string>;
}

export type ServiceStart = { status: "started"; service: RecorderService } | { status: "running"; entry: ServiceEntry };

const movieHandle = moviesApi.handles.find((handle) => handle.name === "Movie");
const movieTable = { methods: movieHandle?.methods ?? [] };
const libraryTable = { methods: moviesApi.methods.filter((method) => ["list", "search"].includes(method.name)) };
const recordingParams = z.object({ recording: z.string().min(1) }).passthrough();

function byOf(connection: Connection): string {
    return connection.state.role === "host" ? "editor" : "agent";
}

/** Who makes a change through a call: the connection's role, and the editor window's holder when the call names one. */
function writerOf(connection: Connection, holder: string | undefined): ChangeWriter {
    return { by: byOf(connection), ...(holder ? { holder } : {}) };
}

/**
 * Starts the recorder service in this process on the shared service host (src/utils/rpc/service-host.ts): it claims
 * `<dir>/service.pid` (a second start, in this process or another, finds the first and answers `running`), listens on
 * `<dir>/service.sock` (a hashed name when that path is too long), and writes `service.json`.
 */
export async function startRecorderService(options: RecorderServiceOptions = {}): Promise<ServiceStart> {
    const dir = options.dir ?? recorderServiceDir();
    const headless = new HeadlessHost(options.headless);
    const hostWaitMs = options.hostWaitMs ?? HOST_WAIT_MS;
    let app: { connection: Connection; host: ConnectedAppHost } | undefined;
    const helloWaiters = new Set<() => void>();
    let stopping = false;
    // Assigned once the host listens; notifications only start then.
    let server: ServiceHost<ConnectionState> | undefined;
    /** The live recordings their processes registered, by id, with the connection that answers their calls. */
    const recordings = new Map<string, { connection: Connection; row: LiveRecordingRow }>();
    const emitRecordings = (change: RecordingsChanged): void => server?.emit(RECORDINGS_CHANGED, { ...change });
    const liveRecordings = (): LiveRecordingRow[] =>
        [...recordings.values()].map(({ row }) => row).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const sessions = new EditSessions({
        onChange: (change) => server?.emit("project.changed", { ...change }),
        saveDelayMs: options.saveDelayMs,
    });

    /** An edit saved to the file with no open session: subscribers hear it as they hear a session's change. */
    const fileChanged = (
        saved: { path: string; project: EditProject },
        connection: Connection,
        action?: ProjectChanged["action"]
    ): void => {
        const change: ProjectChanged = {
            path: saved.path,
            revision: saved.project.revision,
            by: saved.project.updatedBy ?? byOf(connection),
            ...(action ? { action } : {}),
        };
        server?.emit("project.changed", { ...change });
    };

    /** A session's gestures are shared by every holder, so a client's gesture id is keyed by its connection. */
    const gestureKey = (connection: Connection, gesture: string): string => `${connection.state.id}:${gesture}`;
    let lastConnectionId = 0;

    /**
     * The session key of a path: the session's own path as a window holds it, even after its folder was moved away (no
     * recording resolves there any more), or the edit the path names.
     */
    const keyOf = (path: string): string => (sessions.get(path) ? path : editPathOf(path));

    const sessionOf = (path: string): EditSession => {
        const session = sessions.get(keyOf(path));

        if (!session) {
            throw new RpcError(RPC_ERRORS.invalidParams, `no open session of ${path}; call session.open first`);
        }

        return session;
    };

    /** An open session that still has its folder: a change to a moved or trashed recording would make it again. */
    const editableSessionOf = (path: string): EditSession | undefined => {
        const session = sessions.get(keyOf(path));

        if (session?.moved) {
            throw new RpcError(RPC_ERRORS.invalidParams, "the recording was moved or trashed; close this window");
        }

        return session;
    };

    /** The open session of a recording argument, or none; a path that names no recording has none. */
    const openSessionOf = (path: string): EditSession | undefined => {
        try {
            return sessions.get(keyOf(path));
        } catch (error) {
            log.debug({ error, path }, "a host call's path names no recording with an edit");
            return undefined;
        }
    };

    const connectedApp = (method: HostMethod): ConnectedAppHost | undefined =>
        app && !app.connection.closed && app.host.answers(method) ? app.host : undefined;

    /** Waits for a host's hello, or until `done` says the work happened another way, or the deadline. */
    const waitForHost = async (method: HostMethod, done?: () => boolean): Promise<ConnectedAppHost | undefined> => {
        const deadline = Date.now() + hostWaitMs;

        while (Date.now() < deadline && !connectedApp(method) && !done?.()) {
            const wake = Promise.withResolvers<void>();
            helloWaiters.add(wake.resolve);
            const timer = setTimeout(wake.resolve, Math.min(250, Math.max(1, deadline - Date.now())));
            await wake.promise;
            clearTimeout(timer);
            helloWaiters.delete(wake.resolve);
        }

        return connectedApp(method);
    };

    /** A host method for any caller: the connected app, else the headless way (and for windows and the camera, a launch). */
    const callHost = async <M extends HostMethod>(
        method: M,
        params: HostParams<M>,
        context: HostCallContext
    ): Promise<HostResult<M>> => {
        // Render what the window shows: an open session's unsaved changes reach the file first.
        if (method.startsWith("render.")) {
            const path = Reflect.get(params, "path") ?? Reflect.get(params, "edit");
            const session = typeof path === "string" ? openSessionOf(path) : undefined;
            session?.flush();
        }

        const connected = connectedApp(method);

        if (connected) {
            return connected.call(method, params, context);
        }

        if (method === "camera.start" || method === "camera.stop") {
            log.info({ method }, "no recorder host: starting the recorder face and waiting for its hello");
            headless.launchFace();
            const late = await waitForHost(method);

            if (!late) {
                throw new RpcError(
                    RPC_ERRORS.hostUnavailable,
                    `no recorder host said hello within ${hostWaitMs / 1000} s; the camera needs GenesisTools.app's recorder face`
                );
            }

            return late.call(method, params, context);
        }

        if (method === "window.open") {
            // The app's arguments open the window whether or not its face says hello. A host that comes answers the
            // window number; a build without one lists it in editor-open.json.
            const path = Reflect.get(params, "path");
            const answer = await headless.call(method, params, context);
            const shown = () => typeof path === "string" && headless.windowOf(path) !== undefined;
            const late = await waitForHost("window.list", shown);

            if (late) {
                return late.call(method, params, context);
            }

            return answer;
        }

        return headless.call(method, params, context);
    };

    const host: RecorderHost = {
        kind: "app",
        answers: () => true,
        call: (method, params, context = {}) => callHost(method, params, context),
    };

    /** Every method `hello` lists: the service's own, the transport's subscribe, the host's, and the REPL's. */
    const allMethods: string[] = [
        ...serviceApi.methods.map((method) => method.name),
        "subscribe",
        ...HOST_METHODS,
        ...movieTable.methods.map((method) => `movie.${method.name}`),
        ...libraryTable.methods.map((method) => `movies.${method.name}`),
    ];
    const version = protocolVersion(allMethods);

    const serviceHandlers = toRpcTable<typeof serviceApi, HandlerContext>(serviceApi, {
        hello: (params, { connection }: HandlerContext) => {
            if (params.protocol !== SERVICE_PROTOCOL) {
                throw new RpcError(
                    RPC_ERRORS.protocolMismatch,
                    `the recorder service speaks protocol ${SERVICE_PROTOCOL}, not ${params.protocol}`,
                    { protocol: SERVICE_PROTOCOL }
                );
            }

            if (params.role === "host") {
                if (app && app.connection !== connection && !app.connection.closed) {
                    throw new RpcError(
                        RPC_ERRORS.hostTaken,
                        `another recorder host is connected (pid ${app.connection.state.pid})`
                    );
                }

                app = { connection, host: new ConnectedAppHost(connection, params.answers) };
                log.info({ pid: params.pid, answers: params.answers }, "the recorder host connected");

                for (const wake of helloWaiters) {
                    wake();
                }
            }

            connection.state.role = params.role;
            connection.state.pid = params.pid;
            return { protocol: SERVICE_PROTOCOL, methods: allMethods, version };
        },
        "session.open": async (params, { connection, context }: HandlerContext) => {
            const path = editPathOf(params.path);
            const holder = params.holder ?? "";

            if (connection.state.holds.get(path)?.has(holder)) {
                const held = sessionOf(path);
                return { path, ...held.current, undoDepth: held.undoDepth, redoDepth: held.redoDepth };
            }

            // One hold per holder, so one editor window's close leaves another window's session of the same edit.
            const session = await sessions.hold(params.path);

            // The caller went or cancelled, or the service stopped, while the session opened: no one would release it.
            if (context.signal.aborted || stopping) {
                sessions.release(session.path);
                throw new RpcError(RPC_ERRORS.cancelled, `the session of ${session.path} opened after its caller left`);
            }

            const holders = connection.state.holds.get(session.path) ?? new Set<string>();

            // The same holder's other session.open finished first and holds it already.
            if (holders.has(holder)) {
                sessions.release(session.path);
            }

            holders.add(holder);
            connection.state.holds.set(session.path, holders);
            return {
                path: session.path,
                ...session.current,
                undoDepth: session.undoDepth,
                redoDepth: session.redoDepth,
            };
        },
        "session.close": (params, { connection }: HandlerContext) => {
            const path = connection.state.holds.has(params.path) ? params.path : editPathOf(params.path);
            const holders = connection.state.holds.get(path);

            if (!holders?.delete(params.holder ?? "")) {
                return { closed: false };
            }

            if (holders.size === 0) {
                connection.state.holds.delete(path);
            }

            sessions.release(path);
            return { closed: true };
        },
        "edit.apply": async (params, { connection }: HandlerContext) => {
            const session = editableSessionOf(params.path);

            if (session) {
                const answer = await session.apply(params.ops, {
                    ...writerOf(connection, params.holder),
                    baseRevision: params.baseRevision,
                });

                // A REPL or CLI reads the file next: its change is saved at once. The window's are debounced.
                if (connection.state.role !== "host") {
                    session.flush();
                }

                return answer;
            }

            const opened = await editProject(params.path, params.ops, { baseRevision: params.baseRevision });

            if (opened.saved) {
                fileChanged(opened, connection);
            }

            return {
                revision: opened.project.revision,
                project: opened.project,
                ...(opened.warnings ? { warnings: opened.warnings } : {}),
                ...(opened.removedIdleUs ? { removedIdleUs: opened.removedIdleUs } : {}),
                ...(opened.loudness ? { loudness: opened.loudness } : {}),
            };
        },
        "edit.undo": async (params, { connection }: HandlerContext) => {
            const session = editableSessionOf(params.path);

            if (session) {
                const answer = await session.undo(writerOf(connection, params.holder));

                if (connection.state.role !== "host") {
                    session.flush();
                }

                return answer;
            }

            const undone = await withEditSession(
                editPathOf(params.path),
                (held) => held.undo(writerOf(connection, params.holder)),
                { onChange: (change) => server?.emit("project.changed", { ...change }) }
            );
            return { revision: undone.project.revision, project: undone.project, undone: undone.undone };
        },
        "edit.redo": async (params, { connection }: HandlerContext) => {
            const session = editableSessionOf(params.path);

            if (!session) {
                const redone = await withEditSession(
                    editPathOf(params.path),
                    (held) => held.redo(writerOf(connection, params.holder)),
                    { onChange: (change) => server?.emit("project.changed", { ...change }) }
                );
                return { revision: redone.project.revision, project: redone.project, redone: redone.redone };
            }

            const answer = await session.redo(writerOf(connection, params.holder));

            if (connection.state.role !== "host") {
                session.flush();
            }

            return answer;
        },
        "gesture.begin": (params, { connection }: HandlerContext) => {
            const key = gestureKey(connection, params.gesture);
            const answer = sessionOf(params.path).beginGesture(key);
            connection.state.gestures.set(key, keyOf(params.path));
            return answer;
        },
        "gesture.preview": (params, { connection }: HandlerContext) =>
            sessionOf(params.path).previewGesture(gestureKey(connection, params.gesture), params.ops),
        "gesture.commit": (params, { connection }: HandlerContext) => {
            const key = gestureKey(connection, params.gesture);
            connection.state.gestures.delete(key);
            return sessionOf(params.path).commitGesture(key, writerOf(connection, params.holder));
        },
        "gesture.cancel": (params, { connection }: HandlerContext) => {
            const key = gestureKey(connection, params.gesture);
            connection.state.gestures.delete(key);
            return sessionOf(params.path).cancelGesture(key);
        },
        "recordings.register": (params, { connection }: HandlerContext) => {
            if (connection.state.role !== "recording") {
                throw new RpcError(RPC_ERRORS.invalidParams, 'recordings.register needs a hello with role "recording"');
            }

            const [registered] = connection.state.recordings;

            if (registered !== undefined && registered !== params.id) {
                throw new RpcError(
                    RPC_ERRORS.invalidParams,
                    `this connection registered ${registered}; one recording per connection`
                );
            }

            const held = recordings.get(params.id);

            if (held && held.connection !== connection && !held.connection.closed) {
                throw new RpcError(
                    RPC_ERRORS.invalidParams,
                    `the recording ${params.id} is registered by another connection (pid ${held.connection.state.pid})`
                );
            }

            recordings.set(params.id, { connection, row: params });
            connection.state.recordings.add(params.id);

            if (!held || held.connection !== connection) {
                log.info({ id: params.id, kind: params.kind, pid: params.pid }, "a live recording joined");
            }

            emitRecordings({
                id: params.id,
                change: held?.connection === connection ? "changed" : "registered",
                recording: params,
            });
            return { registered: true as const, id: params.id };
        },
        "recordings.live": () => ({ recordings: liveRecordings() }),
        "recording.call": (params, { connection, context }: HandlerContext) => {
            const held = recordings.get(params.id);

            if (!held || held.connection.closed) {
                throw new RpcError(
                    RPC_ERRORS.unknownRecording,
                    `no live recording "${params.id}" is registered with the recorder service`
                );
            }

            log.debug(
                { id: params.id, method: params.method, by: connection.state.pid },
                "forwarding a recording call"
            );
            return held.connection.request(params.method, params.params, {
                timeoutMs: callTimeoutFor(params.method, params.params),
                signal: context.signal,
            });
        },
    });

    const movies = toRpcTable(
        movieTable,
        handleHandlers(movieTable, (context: { recording: string }) => new Movie(context.recording)),
        { prefix: "movie." }
    );
    const library = toRpcTable(
        libraryTable,
        handleHandlers(libraryTable, () => ({
            list: (params: { limit?: number }) => listLibrary({ limit: params.limit ?? 20 }),
            search: (text: string) => searchLibrary(text),
        })),
        { prefix: "movies." }
    );

    const answer = async (method: string, params: unknown, connection: Connection, context: RpcCallContext) => {
        if (method === "window.changed") {
            // The host's notification: every subscriber hears its window rows.
            if (connection === app?.connection && typeof params === "object" && params !== null) {
                server?.emit("window.changed", { ...params });
            }

            return null;
        }

        if (method === RECORDING_EVENT) {
            // A recording's notification: subscribers hear it with the recording's id (one recording per connection).
            const event = recordingEventSchema.omit({ id: true }).safeParse(params);
            const [id] = connection.state.recordings;

            if (event.success && id !== undefined) {
                server?.emit(RECORDING_EVENT, { id, ...event.data });
            }

            return null;
        }

        if (serviceHandlers.has(method)) {
            return serviceHandlers.call(method, params, { connection, context });
        }

        if (isHostMethod(method)) {
            return callHostChecked(method, params, context);
        }

        if (movies.has(method)) {
            const { recording, ...rest } = recordingParams.parse(params ?? {});
            // A REPL method reads the edit file: an open session's changes not saved yet reach it first.
            openSessionOf(recording)?.flush();
            return movies.call(method, rest, { recording });
        }

        if (library.has(method)) {
            return library.call(method, params, undefined);
        }

        throw new RpcError(RPC_ERRORS.methodNotFound, `unknown method ${method}`);
    };

    const callHostChecked = async (method: HostMethod, params: unknown, context: RpcCallContext): Promise<unknown> => {
        const schemas = HOST_SCHEMAS[method];
        const parsed = schemas.params.safeParse(params ?? {});

        if (!parsed.success) {
            const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`);
            throw new RpcError(RPC_ERRORS.invalidParams, `${method}: ${issues.join("; ")}`);
        }

        return callHost(method, parsed.data, {
            signal: context.signal,
            onProgress: (update) => context.progress(update),
        });
    };

    const prewarm = (trigger: string): void => {
        try {
            options.prewarmNative?.(trigger);
        } catch (error) {
            log.warn({ error, trigger }, "the native recorder prewarm failed");
        }
    };

    const start = await startServiceHost<ConnectionState>({
        dir,
        socket: serviceSocketPath(dir),
        label: "recorder service",
        logScope: "recorder-service",
        protocol: SERVICE_PROTOCOL,
        state: () => ({ id: ++lastConnectionId, holds: new Map(), gestures: new Map(), recordings: new Set() }),
        // A cancelled request's edit never lands: every edit it makes checks this request's signal before it saves.
        call: ({ method, params, connection, context }) =>
            withEditCancel(context.signal, () => answer(method, params, connection, context)),
        onClose: (connection) => {
            for (const [key, path] of connection.state.gestures) {
                sessions.get(path)?.cancelGesture(key);
            }

            connection.state.gestures.clear();

            for (const [path, holders] of connection.state.holds) {
                for (const _holder of holders) {
                    sessions.release(path);
                }
            }

            connection.state.holds.clear();

            for (const id of connection.state.recordings) {
                if (recordings.get(id)?.connection === connection) {
                    recordings.delete(id);
                    log.info({ id }, "a live recording left the recorder service");
                    emitRecordings({ id, change: "ended" });
                }
            }

            connection.state.recordings.clear();

            if (app?.connection === connection) {
                log.info({ pid: connection.state.pid }, "the recorder host disconnected");
                app = undefined;
            }
        },
        idleMs: options.idleMs ?? SERVICE_IDLE_MS,
        checkEveryMs: options.checkEveryMs,
        keepAlive: {
            // An open edit session (a window's, or one whose last save still runs) keeps it from the idle exit.
            idle: () => sessions.size > 0,
            // A live recording would lose the service halfway, as a running call would: on 2026-11-09 four exports
            // failed with "the connection closed while the call ran". A code change waits for both.
            codeChange: () => recordings.size > 0,
        },
        // `serve` passes the repo's `src/`; the recorder's service.json readers know no `sourceRoot`.
        sourceRoot: options.sourceRoot,
        publishSourceRoot: false,
        onCheck: () => prewarm("recorder-service-check"),
        // The sessions save and close before the connections end, so a window's last change is on disk.
        onStopping: () => {
            stopping = true;
            sessions.closeAll();
            setEditOwner(undefined);
            setRecorderHostResolver(undefined);
        },
        onStopped: options.onStopped,
    });

    if (start.status === "running") {
        return start;
    }

    server = start.host;
    setEditOwner({ sessionOf: (path) => sessions.get(path) });
    setRecorderHostResolver(() => host);
    prewarm("recorder-service-start");
    log.info({ methods: allMethods.length, version }, "recorder service methods");

    return {
        status: "started",
        service: {
            entry: start.host.entry,
            sessions,
            liveRecordings,
            host,
            stop: start.host.stop,
            stopped: start.host.stopped,
        },
    };
}

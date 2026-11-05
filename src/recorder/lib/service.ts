import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { handleHandlers, toRpcTable } from "@genesiscz/utils/api-descriptor";
import { newestLoadedModuleMtime } from "@genesiscz/utils/bun/loaded-modules";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { claimPidFile, clearPidFile } from "@genesiscz/utils/process/pidfile";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import { readProject } from "@genesiscz/utils/recording-editor/project";
import type { RpcCallContext } from "@genesiscz/utils/rpc/peer";
import { type RpcConnection, RpcSocketServer } from "@genesiscz/utils/rpc/socket-server";
import { RPC_ERRORS, RpcError } from "@genesiscz/utils/screen-recorder/control";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { editPathOf, editProject, setEditOwner, undoEdit } from "./edit";
import { type EditSession, EditSessions } from "./edit-session";
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
    protocolVersion,
    readLiveService,
    recorderServiceDir,
    SERVICE_PROTOCOL,
    type ServiceEntry,
    type ServiceRole,
    serviceApi,
    serviceEntryPath,
    servicePidPath,
    serviceSocketPath,
} from "./service-protocol";
import { Movie, moviesApi } from "./toolset";

const { log } = logger.scoped("recorder-service");

/** The service exits after this long with no connection and no open session. */
export const SERVICE_IDLE_MS = 10 * 60_000;
/** How often it checks the idle rule and the code stamp. */
const CHECK_EVERY_MS = 60_000;
/** Without a host, a window or camera call starts the app and waits this long for its hello. */
const HOST_WAIT_MS = 10_000;
/** A start that finds another start claiming the service waits this long for its entry. */
const RIVAL_WAIT_MS = 15_000;

interface ConnectionState {
    role?: ServiceRole;
    pid?: number;
    /** The edit paths this connection holds sessions of. */
    holds: Set<string>;
}

type Connection = RpcConnection<ConnectionState>;

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
}

export interface RecorderService {
    readonly entry: ServiceEntry;
    readonly sessions: EditSessions;
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

/**
 * Starts the recorder service in this process: claims `<dir>/service.pid` (a second start, in this process or
 * another, finds the first and answers `running`), listens on `<dir>/service.sock`, and writes `service.json`.
 */
export async function startRecorderService(options: RecorderServiceOptions = {}): Promise<ServiceStart> {
    const dir = options.dir ?? recorderServiceDir();
    mkdirSync(dir, { recursive: true });
    const pidPath = servicePidPath(dir);
    // A live holder keeps the claim, this process's own included: one service per folder.
    const claim = await claimPidFile(pidPath, {
        reclaimable: (state) => state.status !== "live" && state.status !== "unverified",
    });

    if (claim.status !== "claimed") {
        const deadline = Date.now() + RIVAL_WAIT_MS;

        for (;;) {
            const entry = readLiveService(dir);

            if (entry) {
                log.info({ dir, pid: entry.pid }, "a recorder service runs already");
                return { status: "running", entry };
            }

            if (Date.now() >= deadline) {
                throw new Error(`another recorder service is starting in ${dir} and did not come up`);
            }

            await Bun.sleep(Math.min(200, deadline - Date.now()));
        }
    }

    try {
        return { status: "started", service: listen(dir, options) };
    } catch (error) {
        clearPidFile(pidPath);
        throw error;
    }
}

function listen(dir: string, options: RecorderServiceOptions): RecorderService {
    const socket = serviceSocketPath(dir);
    const entryPath = serviceEntryPath(dir);
    const startedAt = Date.now();
    const pidCommand = readProcessCommand(process.pid);
    const entry: ServiceEntry = {
        version: 1,
        protocol: SERVICE_PROTOCOL,
        pid: process.pid,
        ...(pidCommand ? { pidCommand } : {}),
        socket,
        startedAt: new Date(startedAt).toISOString(),
        codeStamp: startedAt,
    };
    const headless = new HeadlessHost(options.headless);
    const hostWaitMs = options.hostWaitMs ?? HOST_WAIT_MS;
    let app: { connection: Connection; host: ConnectedAppHost } | undefined;
    const helloWaiters = new Set<() => void>();
    let lastBusy = Date.now();
    let stopping = false;
    const stopped = Promise.withResolvers<string>();
    // `server` is assigned below; notifications only start once it listens.
    let server: RpcSocketServer<ConnectionState> | undefined;
    const sessions = new EditSessions({
        onChange: (change) => server?.emit("project.changed", { ...change }),
        saveDelayMs: options.saveDelayMs,
    });

    const sessionOf = (path: string): EditSession => {
        const session = sessions.get(editPathOf(path));

        if (!session) {
            throw new RpcError(RPC_ERRORS.invalidParams, `no open session of ${path}; call session.open first`);
        }

        return session;
    };

    /** The open session of a recording argument, or none; a path that names no recording has none. */
    const openSessionOf = (path: string): EditSession | undefined => {
        try {
            return sessions.get(editPathOf(path));
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

    const serviceHandlers = toRpcTable(serviceApi, {
        hello: (params, { connection }: { connection: Connection }) => {
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
        "session.open": async (params, { connection }: { connection: Connection }) => {
            const path = editPathOf(params.path);

            if (connection.state.holds.has(path)) {
                return { path, ...sessionOf(path).current };
            }

            const session = await sessions.hold(params.path);
            connection.state.holds.add(session.path);
            return { path: session.path, ...session.current };
        },
        "session.close": (params, { connection }: { connection: Connection }) => {
            const path = editPathOf(params.path);

            if (!connection.state.holds.delete(path)) {
                return { closed: false };
            }

            sessions.release(path);
            lastBusy = Date.now();
            return { closed: true };
        },
        "edit.apply": async (params, { connection }: { connection: Connection }) => {
            const session = sessions.get(editPathOf(params.path));

            if (session) {
                const answer = await session.apply(params.ops, {
                    by: byOf(connection),
                    baseRevision: params.baseRevision,
                });

                // A REPL or CLI reads the file next: its change is saved at once. The window's are debounced.
                if (connection.state.role !== "host") {
                    session.flush();
                }

                return answer;
            }

            if (params.baseRevision !== undefined) {
                const path = editPathOf(params.path);
                const revision = existsSync(path) ? readProject(path).revision : 0;

                if (revision !== params.baseRevision) {
                    throw new RpcError(
                        RPC_ERRORS.staleRevision,
                        `the edit is at revision ${revision}, not ${params.baseRevision}`
                    );
                }
            }

            const opened = await editProject(params.path, params.ops);
            return {
                revision: opened.project.revision,
                project: opened.project,
                ...(opened.warnings ? { warnings: opened.warnings } : {}),
                ...(opened.removedIdleUs ? { removedIdleUs: opened.removedIdleUs } : {}),
                ...(opened.loudness ? { loudness: opened.loudness } : {}),
            };
        },
        "edit.undo": async (params, { connection }: { connection: Connection }) => {
            const session = sessions.get(editPathOf(params.path));

            if (session) {
                const answer = await session.undo({ by: byOf(connection) });

                if (connection.state.role !== "host") {
                    session.flush();
                }

                return answer;
            }

            const undone = await undoEdit(params.path);
            return { revision: undone.project.revision, project: undone.project, undone: undone.undone ?? [] };
        },
        "edit.redo": async (params, { connection }: { connection: Connection }) => {
            const session = sessions.get(editPathOf(params.path));

            if (!session) {
                throw new RpcError(RPC_ERRORS.nothingToRedo, "redo needs an open session of the edit (session.open)");
            }

            const answer = await session.redo({ by: byOf(connection) });

            if (connection.state.role !== "host") {
                session.flush();
            }

            return answer;
        },
        "gesture.begin": (params) => sessionOf(params.path).beginGesture(params.gesture),
        "gesture.preview": (params) => sessionOf(params.path).previewGesture(params.gesture, params.ops),
        "gesture.commit": (params, { connection }: { connection: Connection }) =>
            sessionOf(params.path).commitGesture(params.gesture, { by: byOf(connection) }),
        "gesture.cancel": (params) => sessionOf(params.path).cancelGesture(params.gesture),
    });

    const movies = toRpcTable(
        movieTable,
        handleHandlers(movieTable, (context: { recording: string }) => new Movie(context.recording)),
        { prefix: "movie." }
    );
    const library = toRpcTable(
        libraryTable,
        handleHandlers(libraryTable, () => ({
            list: (params: { limit?: number }) => listLibrary().slice(0, params.limit ?? 20),
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

        if (serviceHandlers.has(method)) {
            return serviceHandlers.call(method, params, { connection });
        }

        if (isHostMethod(method)) {
            return callHostChecked(method, params, context);
        }

        if (movies.has(method)) {
            const { recording, ...rest } = recordingParams.parse(params ?? {});
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

    const removeFiles = (): void => {
        server?.stopListening();

        try {
            const written = existsSync(entryPath)
                ? z
                      .object({ pid: z.number() })
                      .safeParse(SafeJSON.parse(readFileSync(entryPath, "utf8"), { strict: true }))
                : undefined;

            if (written?.success && written.data.pid === process.pid) {
                unlinkSync(entryPath);
            }
        } catch (error) {
            log.debug({ error, entryPath }, "service.json went away before the stop");
        }

        if (existsSync(socket)) {
            unlinkSync(socket);
        }
    };

    const stop = (reason: string): void => {
        if (stopping) {
            return;
        }

        stopping = true;
        clearInterval(check);
        log.info(
            { reason, sessions: sessions.size, connections: server?.connections.length },
            "recorder service stopping"
        );
        sessions.closeAll();
        setEditOwner(undefined);
        setRecorderHostResolver(undefined);
        server?.endConnections();

        try {
            withPathArbitrationSync(socket, removeFiles);
        } catch (error) {
            log.warn({ error, socket }, "recorder service socket lock busy; removing without it");
            removeFiles();
        }

        clearPidFile(servicePidPath(dir));
        options.onStopped?.(reason);
        stopped.resolve(reason);
    };

    server = withPathArbitrationSync(socket, () => {
        if (existsSync(socket)) {
            unlinkSync(socket);
        }

        const listening = new RpcSocketServer<ConnectionState>({
            socket,
            state: () => ({ holds: new Set() }),
            call: ({ method, params, connection, context }) => answer(method, params, connection, context),
            onOpen: () => {
                lastBusy = Date.now();
            },
            onClose: (connection) => {
                lastBusy = Date.now();

                for (const path of connection.state.holds) {
                    sessions.release(path);
                }

                connection.state.holds.clear();

                if (app?.connection === connection) {
                    log.info({ pid: connection.state.pid }, "the recorder host disconnected");
                    app = undefined;
                }
            },
            logScope: "recorder-service",
            label: "recorder service",
        });
        atomicWriteFileSync(entryPath, SafeJSON.stringify(entry, null, 2));
        return listening;
    });
    setEditOwner({ sessionOf: (path) => sessions.get(path) });
    setRecorderHostResolver(() => host);

    const idleMs = options.idleMs ?? SERVICE_IDLE_MS;
    const check = setInterval(() => {
        if (options.sourceRoot && newestLoadedModuleMtime(options.sourceRoot) > startedAt) {
            log.info("recorder service code changed since start; exiting so the next caller starts the new code");
            stop("code-changed");
            return;
        }

        if (
            idleMs > 0 &&
            (server?.connections.length ?? 0) === 0 &&
            sessions.size === 0 &&
            Date.now() - lastBusy >= idleMs
        ) {
            stop("idle");
        }
    }, options.checkEveryMs ?? CHECK_EVERY_MS);
    log.info({ dir, socket, pid: process.pid, methods: allMethods.length, version }, "recorder service listening");

    return {
        entry,
        sessions,
        host,
        stop,
        stopped: stopped.promise,
    };
}

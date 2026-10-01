import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { physFootprintBytes } from "@genesiscz/utils/process/footprint";
import { withTraceId } from "@genesiscz/utils/trace";
import type { Door } from "./doors/types";
import { type CallResult, type EndReason, type HubServerHealth, LineBuffer, parseRequest } from "./protocol";

const log = logger.child({ component: "hub-server" });

export interface HubServerOptions {
    socketPath: string;
    doors: readonly Door[];
    /** Drain and exit above this physical footprint (RSS where the platform has none; see utils/process/footprint). */
    maxFootprintBytes: number;
    /** Exit after this long with no connection. 0 = never. */
    idleMs: number;
    /** How often to check memory and the code stamp. */
    checkEveryMs: number;
    /** The default call deadline when a request names none. */
    callTimeoutMs: number;
    /** Repo source root: a loaded module under it that changed after start means "restart". */
    sourceRoot?: string;
    /** Called once, after the drain, with the reason. The CLI exits the process here. */
    onStopped?: (reason: string) => void;
}

export interface HubServerHandle {
    health(): HubServerHealth;
    /** Stop accepting, end subscriptions with `reason`, wait for calls (10 s at most), close. */
    drain(reason: string): Promise<void>;
}

interface Connection {
    socket: Socket;
    subscriptions: Map<number, AbortController>;
}

const DRAIN_DEADLINE_MS = 10_000;

/** What macOS charges this process; RSS overstates a bun process by the pages it already gave back. */
function footprintBytes(): number {
    return physFootprintBytes() ?? process.memoryUsage.rss();
}
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 10 * 60_000;

/** True when another server answers on the socket within a second. */
export async function socketAnswers(socketPath: string, deadlineMs = 1000): Promise<boolean> {
    if (!existsSync(socketPath)) {
        return false;
    }

    return new Promise((resolve) => {
        const socket = createConnection(socketPath);
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, deadlineMs);
        socket.once("connect", () => {
            clearTimeout(timer);
            socket.end();
            resolve(true);
        });
        socket.once("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

/**
 * Newest mtime among the loaded modules under `root`, in ms. A module edited after this process
 * started means the server runs old code: it drains, and the hub's next call starts the new code.
 */
export function newestLoadedModuleMtime(root: string): number {
    let newest = 0;
    for (const path of Object.keys(require.cache)) {
        if (!path.startsWith(root)) {
            continue;
        }

        try {
            newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
            // A module file that was deleted counts as changed.
            newest = Number.POSITIVE_INFINITY;
        }
    }

    return newest;
}

/**
 * The resident hub server: line-delimited JSON over a unix socket (src/hub/server/protocol.ts).
 * Returns null when another server already answers on the socket.
 */
export async function startHubServer(options: HubServerOptions): Promise<HubServerHandle | null> {
    if (await socketAnswers(options.socketPath)) {
        log.info({ socket: options.socketPath }, "hub server already running; not starting a second one");
        return null;
    }

    const dir = dirname(options.socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(options.socketPath)) {
        // Nothing answered: a socket file left by a server that died.
        unlinkSync(options.socketPath);
    }

    const startedAt = Date.now();
    const connections = new Set<Connection>();
    const inFlight = new Set<Promise<unknown>>();
    const crashes: number[] = [];
    let calls = 0;
    let errors = 0;
    let draining: Promise<void> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const callDoors = options.doors.filter((door) => door.kind === "call");
    const streamDoors = options.doors.filter((door) => door.kind === "stream");

    const send = (connection: Connection, message: Record<string, unknown>): void => {
        if (connection.socket.destroyed || !connection.socket.writable) {
            return;
        }

        connection.socket.write(`${SafeJSON.stringify(message, { strict: true })}\n`);
    };

    const health = (): HubServerHealth => ({
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
        codeStamp: startedAt,
        rssBytes: process.memoryUsage.rss(),
        footprintBytes: footprintBytes(),
        connections: connections.size,
        subscriptions: [...connections].reduce((sum, connection) => sum + connection.subscriptions.size, 0),
        calls,
        errors,
        doors: options.doors.map((door) => door.name),
    });

    const armIdle = (): void => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }

        if (options.idleMs > 0 && connections.size === 0 && !draining) {
            idleTimer = setTimeout(() => {
                void drain("idle");
            }, options.idleMs);
        }
    };

    const track = <T>(promise: Promise<T>): Promise<T> => {
        inFlight.add(promise);
        promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
        return promise;
    };

    const runCall = async (connection: Connection, id: number, argv: string[], timeoutMs?: number): Promise<void> => {
        for (const door of callDoors) {
            const parsed = door.match(argv);
            if (parsed === null) {
                continue;
            }

            calls++;
            const started = performance.now();
            const cpu = process.cpuUsage();
            const deadline = timeoutMs ?? options.callTimeoutMs;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<CallResult>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve({ stdout: "", stderr: `hub server: ${door.name} exceeded ${deadline} ms\n`, exit: 124 });
                }, deadline);
            });
            let result: CallResult;
            try {
                result = await Promise.race([door.run(parsed, { signal: controller.signal }), timeout]);
            } catch (error) {
                errors++;
                log.warn({ error, door: door.name }, "hub server door threw");
                result = { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exit: 1 };
            } finally {
                clearTimeout(timer);
            }

            const used = process.cpuUsage(cpu);
            const ms = Math.round(performance.now() - started);
            log.debug(
                {
                    door: door.name,
                    ms,
                    exit: result.exit,
                    bytes: result.stdout.length,
                    ...(result.exit !== 0 && { stderr: result.stderr.slice(-300) }),
                },
                "hub server call"
            );
            send(connection, {
                id,
                ok: true,
                ...result,
                ms,
                cpuMs: Math.round((used.user + used.system) / 1000),
            });
            return;
        }

        send(connection, { id, ok: false, code: "unsupported" });
    };

    const runStream = async (connection: Connection, id: number, argv: string[]): Promise<void> => {
        for (const door of streamDoors) {
            const parsed = door.match(argv);
            if (parsed === null) {
                continue;
            }

            if (connection.subscriptions.has(id)) {
                send(connection, { id, ok: false, code: "bad-request" });
                return;
            }

            const controller = new AbortController();
            connection.subscriptions.set(id, controller);
            let batch: string[] = [];
            const write = (line: string): void => {
                if (controller.signal.aborted) {
                    return;
                }

                batch.push(line);
                if (batch.length === 1) {
                    // Lines written in one synchronous burst (one envelope) leave as one message.
                    queueMicrotask(() => {
                        const lines = batch;
                        batch = [];
                        send(connection, { id, lines });
                    });
                }
            };
            log.debug({ door: door.name, id }, "hub server subscription started");
            let result: CallResult;
            try {
                result = await door.stream(parsed, { signal: controller.signal, write });
            } catch (error) {
                errors++;
                log.warn({ error, door: door.name }, "hub server stream door threw");
                result = { stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n`, exit: 1 };
            }

            connection.subscriptions.delete(id);
            const reason: EndReason = draining
                ? "restart"
                : controller.signal.aborted
                  ? "cancelled"
                  : result.exit === 0
                    ? "done"
                    : "error";
            send(connection, { id, end: true, exit: result.exit, stderr: result.stderr, reason });
            log.debug({ door: door.name, id, reason }, "hub server subscription ended");
            return;
        }

        send(connection, { id, ok: false, code: "unsupported" });
    };

    const handleLine = (connection: Connection, line: string): void => {
        const request = parseRequest(line);
        if (!request) {
            send(connection, { id: null, ok: false, code: "bad-request" });
            return;
        }

        if (request.op === "health") {
            send(connection, { id: request.id, ok: true, health: health() });
            return;
        }

        if (request.op === "drain") {
            send(connection, { id: request.id, ok: true });
            void drain("asked");
            return;
        }

        if (request.op === "cancel") {
            connection.subscriptions.get(request.id)?.abort();
            return;
        }

        if (draining) {
            send(connection, { id: request.id, ok: false, code: "draining" });
            return;
        }

        // The app's trace id scopes everything the door logs or profiles (utils/trace.ts).
        const work = withTraceId(request.traceId, () =>
            request.op === "call"
                ? runCall(connection, request.id, request.argv, request.timeoutMs)
                : runStream(connection, request.id, request.argv)
        );
        track(work).catch((error: unknown) => {
            errors++;
            log.warn({ error }, "hub server request failed outside its door");
        });
    };

    const server: Server = createServer((socket) => {
        const connection: Connection = { socket, subscriptions: new Map() };
        connections.add(connection);
        armIdle();
        const lines = new LineBuffer();
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            const complete = lines.push(chunk);
            if (complete === null) {
                log.warn("hub server: request line over the limit; closing that connection");
                socket.destroy();
                return;
            }

            for (const line of complete) {
                handleLine(connection, line);
            }
        });
        const close = (): void => {
            for (const controller of connection.subscriptions.values()) {
                controller.abort();
            }

            connection.subscriptions.clear();
            connections.delete(connection);
            armIdle();
        };
        socket.on("close", close);
        socket.on("error", (error) => {
            log.debug({ error }, "hub server connection error");
        });
    });

    const previousUmask = process.umask(0o077);
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(options.socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
    } finally {
        process.umask(previousUmask);
    }

    chmodSync(options.socketPath, 0o600);
    log.info({ socket: options.socketPath, pid: process.pid, doors: options.doors.length }, "hub server listening");

    const check = setInterval(() => {
        const footprint = footprintBytes();
        if (footprint > options.maxFootprintBytes) {
            log.warn({ footprint, max: options.maxFootprintBytes }, "hub server over its memory cap; restarting");
            void drain("memory");
            return;
        }

        if (options.sourceRoot && newestLoadedModuleMtime(options.sourceRoot) > startedAt) {
            log.info("hub server code changed since start; restarting");
            void drain("code-changed");
        }
    }, options.checkEveryMs);

    const onCrash = (error: unknown): void => {
        errors++;
        const now = Date.now();
        crashes.push(now);
        while (crashes.length > 0 && crashes[0] < now - CRASH_WINDOW_MS) {
            crashes.shift();
        }

        log.error({ error, recent: crashes.length }, "hub server: uncaught error (the server keeps running)");
        if (crashes.length >= CRASH_LIMIT) {
            void drain("crashes");
        }
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);

    const drain = (reason: string): Promise<void> => {
        if (draining) {
            return draining;
        }

        draining = (async () => {
            log.info({ reason, calls, errors }, "hub server draining");
            clearInterval(check);
            if (idleTimer) {
                clearTimeout(idleTimer);
            }

            const closed = new Promise<void>((resolve) => server.close(() => resolve()));
            for (const connection of connections) {
                for (const controller of connection.subscriptions.values()) {
                    controller.abort();
                }
            }

            let deadline: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                Promise.allSettled([...inFlight]),
                new Promise<void>((resolve) => {
                    deadline = setTimeout(resolve, DRAIN_DEADLINE_MS);
                }),
            ]);
            clearTimeout(deadline);
            for (const connection of connections) {
                connection.socket.end();
            }

            await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
            process.off("uncaughtException", onCrash);
            process.off("unhandledRejection", onCrash);
            log.info({ reason }, "hub server stopped");
            options.onStopped?.(reason);
        })();
        return draining;
    };

    armIdle();
    return { health, drain };
}

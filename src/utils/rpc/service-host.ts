import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { newestLoadedModuleMtime } from "@genesiscz/utils/bun/loaded-modules";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { claimPidFile, clearPidFile } from "@genesiscz/utils/process/pidfile";
import { awaitStart, startGatePath, stopPassedChild, sweepStartGates } from "@genesiscz/utils/process/start-gate";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { type RpcCall, type RpcConnection, RpcSocketServer } from "./socket-server";

/**
 * The host part of a resident JSON-RPC service: one per folder on this Mac, found through `<dir>/service.json`, on
 * the socket it names (`<dir>/service.sock` by default), claimed by `<dir>/service.pid`. It exits after an idle stretch with no connection, and once a
 * module it loaded changed (when no call runs), so the next caller starts the new code. The service itself answers
 * the methods (`call`); the transport answers `subscribe`.
 *
 * The recorder service (src/recorder/lib/service.ts) and the Meetings service (src/meetings/lib/service/service.ts)
 * both run on it. A service's own lines log under its `logScope`, so a day-log search by the service's scope finds
 * its starts and exits too.
 */

const hostLog = logger.scoped("rpc-service-host");
const { log } = hostLog;

/** How long a second start waits for a rival start in the same folder to write its service.json. */
const RIVAL_WAIT_MS = 15_000;
const CHECK_EVERY_MS = 60_000;

export function serviceSocketPath(dir: string): string {
    return join(dir, "service.sock");
}

export function servicePidPath(dir: string): string {
    return join(dir, "service.pid");
}

export function serviceEntryPath(dir: string): string {
    return join(dir, "service.json");
}

/** `service.json`: where the running service listens, and what it speaks. */
export const serviceEntrySchema = z.object({
    version: z.literal(1),
    protocol: z.number().int(),
    pid: z.number().int().positive(),
    /** The service's command line when it wrote the entry, so a recycled pid reads as gone. */
    pidCommand: z.string().optional(),
    socket: z.string(),
    startedAt: z.string(),
    /** When the service started, in ms; a loaded module that changed after it makes the service exit. */
    codeStamp: z.number(),
    /** The code the service runs (a hash of its checkout), which a client compares before it connects. */
    code: z.string().optional(),
    /**
     * The checkout the service runs from, as a decoded absolute path with a trailing separator (`/…/GenesisTools/`),
     * as Bun loaded the code (symlinks already resolved: `/tmp/…` reads `/private/tmp/…`). A client that runs no
     * TypeScript (the Meetings window) compares it with the checkout of the `tools` it calls, both resolved, and reads
     * through the command on a mismatch.
     */
    sourceRoot: z.string().optional(),
});
export type ServiceEntry = z.infer<typeof serviceEntrySchema>;

/** The running service named in `<dir>/service.json`, or undefined when there is none or its process is gone. */
export function readLiveServiceEntry(dir: string): ServiceEntry | undefined {
    const path = serviceEntryPath(dir);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const entry = serviceEntrySchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        const status = classifyPid(entry.pid, entry.pidCommand).status;
        return status === "live" || status === "unverified" ? entry : undefined;
    } catch (error) {
        log.debug({ error, path }, "service.json does not read; no service");
        return undefined;
    }
}

export interface ServiceHostOptions<S> {
    /** The folder of service.json, service.sock and service.pid. */
    dir: string;
    /** The socket path; `<dir>/service.sock` by default. The recorder's is a hashed name when that path is too long. */
    socket?: string;
    /** The name in log lines and messages (`meetings service`). */
    label: string;
    logScope: string;
    /** The protocol number service.json names. */
    protocol: number;
    /** The code stamp service.json names (`ServiceEntry.code`). */
    code?: string;
    /** The state of a new connection. */
    state: () => S;
    /** Answers every method but `subscribe`; throw an RpcError to refuse. */
    call: (call: RpcCall<S>) => Promise<unknown>;
    /** A connection subscribed; `params` as it sent them (a service keeps its own filters from them). */
    onSubscribe?: (connection: RpcConnection<S>, params: unknown) => void;
    onOpen?: (connection: RpcConnection<S>) => void;
    onClose?: (connection: RpcConnection<S>) => void;
    /** Exit after this long with no connection and no call; 0 never exits for idleness. */
    idleMs: number;
    checkEveryMs?: number;
    /**
     * What keeps the service besides a connection and a running call, per exit: `idle` holds back the idle exit (the
     * recorder's open edit sessions), `codeChange` the exit on a code change (the recorder's live recordings).
     */
    keepAlive?: { idle?: () => boolean; codeChange?: () => boolean };
    /** A module loaded from under this root that changed after the start makes the service exit once no call runs. */
    sourceRoot?: string;
    /** service.json names `sourceRoot` (default true); the recorder's readers know no such field. */
    publishSourceRoot?: boolean;
    /** Runs at each check, before the exit rules (the recorder builds a stale native recorder ahead). */
    onCheck?: () => void;
    /** Runs once when a stop begins, before the connections end (the recorder saves and closes its edit sessions). */
    onStopping?: (reason: string) => void;
    onStopped?: (reason: string) => void;
    /** How long a second start waits for a rival start's service.json (tests shorten it). */
    rivalWaitMs?: number;
    /** A method whose newer call on a connection cancels its older ones (`RpcPeerOptions.supersedes`). */
    supersedes?: (method: string) => string | undefined;
}

export interface ServiceHost<S> {
    readonly entry: ServiceEntry;
    readonly connections: readonly RpcConnection<S>[];
    /** True while no module loaded from the source root changed since the start; checked now. */
    codeIsCurrent(): boolean;
    /** A notification to every connection that subscribed to `event` (and passes `to`, when given). */
    emit(event: string, params: Record<string, unknown>, to?: (connection: RpcConnection<S>) => boolean): void;
    stop(reason: string): void;
    readonly stopped: Promise<string>;
}

/** A start: this process now hosts the service, or another process does already. */
export type ServiceHostStart<S> =
    | { status: "started"; host: ServiceHost<S> }
    | { status: "running"; entry: ServiceEntry };

/**
 * Starts the service in this process: claims `<dir>/service.pid` (a second start, in this process or another, finds
 * the first and answers `running`), listens on its socket (`options.socket`, else `<dir>/service.sock`), and writes
 * `service.json`.
 */
export async function startServiceHost<S>(options: ServiceHostOptions<S>): Promise<ServiceHostStart<S>> {
    const { dir } = options;
    const { log } = logger.scoped(options.logScope);
    // The service answers with the owner's private data, and `hello` is no login: only the owner may reach its folder.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const pidPath = servicePidPath(dir);
    // A live holder keeps the claim, this process's own included: one service per folder.
    const claim = await claimPidFile(pidPath, {
        reclaimable: (state) => state.status !== "live" && state.status !== "unverified",
    });

    if (claim.status !== "claimed") {
        const deadline = Date.now() + (options.rivalWaitMs ?? RIVAL_WAIT_MS);

        for (;;) {
            const entry = readLiveServiceEntry(dir);

            if (entry) {
                log.info({ dir, pid: entry.pid }, `a ${options.label} runs already`);
                return { status: "running", entry };
            }

            if (Date.now() >= deadline) {
                throw new Error(`another ${options.label} is starting in ${dir} and did not come up`);
            }

            await Bun.sleep(Math.min(200, deadline - Date.now()));
        }
    }

    try {
        return { status: "started", host: listen(options) };
    } catch (error) {
        clearPidFile(pidPath);
        throw error;
    }
}

function listen<S>(options: ServiceHostOptions<S>): ServiceHost<S> {
    const { dir, label } = options;
    const { log } = logger.scoped(options.logScope);
    const socket = options.socket ?? serviceSocketPath(dir);
    const entryPath = serviceEntryPath(dir);
    const startedAt = Date.now();
    const pidCommand = readProcessCommand(process.pid);
    const entry: ServiceEntry = {
        version: 1,
        protocol: options.protocol,
        pid: process.pid,
        ...(pidCommand ? { pidCommand } : {}),
        socket,
        startedAt: new Date(startedAt).toISOString(),
        codeStamp: startedAt,
        ...(options.code ? { code: options.code } : {}),
        ...(options.sourceRoot && options.publishSourceRoot !== false ? { sourceRoot: options.sourceRoot } : {}),
    };
    let lastBusy = Date.now();
    /** Calls answered now: a code change waits for them, so a call never loses its service halfway. */
    let callsRunning = 0;
    let stopping = false;
    const stopped = Promise.withResolvers<string>();
    let server: RpcSocketServer<S> | undefined;

    const codeIsCurrent = (): boolean =>
        !options.sourceRoot || newestLoadedModuleMtime(options.sourceRoot) <= startedAt;

    const removeFiles = (): void => {
        server?.stopListening();

        try {
            const written = existsSync(entryPath)
                ? z
                      .object({ pid: z.number() })
                      .safeParse(SafeJSON.parse(readFileSync(entryPath, "utf8"), { strict: true }))
                : undefined;

            // A newer service may own the folder already; only this process's own entry goes.
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
        log.info({ reason, connections: server?.connections.length }, `${label} stopping`);
        options.onStopping?.(reason);
        server?.endConnections();

        try {
            withPathArbitrationSync(socket, removeFiles);
        } catch (error) {
            log.warn({ error, socket }, `${label} socket lock busy; removing without it`);
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

        const listening = new RpcSocketServer<S>({
            socket,
            state: options.state,
            call: async (call) => {
                callsRunning += 1;

                try {
                    return await options.call(call);
                } finally {
                    callsRunning -= 1;
                    lastBusy = Date.now();
                }
            },
            onSubscribe: options.onSubscribe,
            onOpen: (connection) => {
                lastBusy = Date.now();
                options.onOpen?.(connection);
            },
            onClose: (connection) => {
                lastBusy = Date.now();
                options.onClose?.(connection);
            },
            logScope: options.logScope,
            label,
            ...(options.supersedes ? { supersedes: options.supersedes } : {}),
        });
        // Only the owner may connect, also where the folder's mode is not checked on the way in.
        chmodSync(socket, 0o600);
        atomicWriteFileSync(entryPath, SafeJSON.stringify(entry, null, 2));
        return listening;
    });

    const check = setInterval(() => {
        options.onCheck?.();

        if (!codeIsCurrent()) {
            if (callsRunning > 0 || options.keepAlive?.codeChange?.() === true) {
                log.info({ calls: callsRunning }, `${label} code changed; exiting once nothing keeps it`);
                return;
            }

            log.info(`${label} code changed since start; exiting so the next caller starts the new code`);
            stop("code-changed");
            return;
        }

        const idleMs = options.idleMs;
        const kept = callsRunning > 0 || options.keepAlive?.idle?.() === true;

        if (idleMs > 0 && !kept && (server?.connections.length ?? 0) === 0 && Date.now() - lastBusy >= idleMs) {
            stop("idle");
        }
    }, options.checkEveryMs ?? CHECK_EVERY_MS);
    log.info({ dir, socket, pid: process.pid }, `${label} listening`);

    return {
        entry,
        get connections() {
            return server?.connections ?? [];
        },
        codeIsCurrent,
        emit: (event, params, to) => server?.emit(event, params, to),
        stop,
        stopped: stopped.promise,
    };
}

/** A start of a service in its own process: it ran already, it started, or why it did not. */
export type ServiceLaunch =
    | { status: "running" | "started"; entry: ServiceEntry }
    | { status: "failed"; reason: string };

/** How long a launch waits for the service to listen. */
const START_TIMEOUT_MS = 15_000;
const START_GRACE_MS = 5_000;
const START_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Starts `tools <command…> --start-gate <gate>` in its own process (through the GenesisTools launcher, so the service
 * keeps GenesisTools.app's privacy grants) and waits for its service.json; a running service is answered as it is.
 */
export async function launchService(options: {
    dir: string;
    /** The tool command that serves, without the gate (`["meetings", "serve"]`). */
    command: readonly string[];
    /** The folder of the start gates. */
    gates: string;
    label: string;
    /** The scope of its log lines: the service's own (`recorder-service`); the host's by default. */
    logScope?: string;
    timeoutMs?: number;
}): Promise<ServiceLaunch> {
    const { dir, label } = options;
    const { log } = options.logScope ? logger.scoped(options.logScope) : hostLog;
    const running = readLiveServiceEntry(dir);

    if (running) {
        return { status: "running", entry: running };
    }

    mkdirSync(options.gates, { recursive: true });
    sweepStartGates(options.gates, START_GATE_MAX_AGE_MS);
    const gate = startGatePath(options.gates);
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
    log.info({ gate }, `starting the ${label}`);
    spawnToolDetached([...options.command, "--start-gate", gate], { reparent: true });
    const outcome = await awaitStart({
        gate,
        find: () => readLiveServiceEntry(dir),
        timeoutMs,
        graceMs: START_GRACE_MS,
        pollMs: 200,
        stop: (pid) => {
            stopPassedChild({
                gate,
                pid,
                signal: (target) => {
                    log.warn({ pid: target, gate }, `the ${label} passed its start but never listened`);
                    // pid-verified: stopPassedChild calls this only after inspectPidFile confirmed the gate's writer is this live process
                    process.kill(target, "SIGTERM");
                },
            });
        },
    });

    if (outcome.status === "started") {
        log.info({ pid: outcome.value.pid, ms: Date.now() - startedAt }, `the ${label} started`);
        return { status: "started", entry: outcome.value };
    }

    const reason = `the ${label} did not start within ${(timeoutMs + START_GRACE_MS) / 1000} s (${outcome.status}); run ${toolCommand(options.command.join(" "))} in a terminal to see why`;
    log.warn({ status: outcome.status, ms: Date.now() - startedAt }, reason);
    return { status: "failed", reason };
}

/** A stop of the service a folder names: it stopped, none ran, its pid could not be told from another process, or it did not exit in time. */
export type ServiceStop =
    | { status: "stopped"; entry: ServiceEntry }
    | { status: "none" }
    | { status: "unverified"; entry: ServiceEntry }
    | { status: "timeout"; entry: ServiceEntry };

/**
 * Stops the running service of `dir` with SIGTERM (it stops like on Ctrl-C: answers already written go out, its files
 * go) and waits until its process is gone. Only a pid whose command line still matches the one service.json recorded
 * is signalled, so a recycled pid is never killed; without that proof it answers `unverified` and signals nothing.
 */
export async function stopService(dir: string, options: { timeoutMs?: number } = {}): Promise<ServiceStop> {
    const entry = readLiveServiceEntry(dir);

    if (!entry) {
        return { status: "none" };
    }

    if (classifyPid(entry.pid, entry.pidCommand).status !== "live") {
        return { status: "unverified", entry };
    }

    // pid-verified: classifyPid confirmed the pid runs the command line the service wrote into service.json
    process.kill(entry.pid, "SIGTERM");
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);

    while (classifyPid(entry.pid, entry.pidCommand).status === "live") {
        if (Date.now() >= deadline) {
            return { status: "timeout", entry };
        }

        await Bun.sleep(Math.min(100, deadline - Date.now()));
    }

    return { status: "stopped", entry };
}

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
 * `<dir>/service.sock`, claimed by `<dir>/service.pid`. It exits after an idle stretch with no connection, and once a
 * module it loaded changed (when no call runs), so the next caller starts the new code. The service itself answers
 * the methods (`call`); the transport answers `subscribe`.
 *
 * Extracted from the recorder service (src/recorder/lib/service.ts) for the Meetings service; the recorder moves onto
 * it in a follow-up (F0r), so until then the recorder keeps its own copy of this logic.
 */

const { log } = logger.scoped("rpc-service-host");

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
    /** Something besides a connection keeps the service (the recorder's open edit sessions). */
    busy?: () => boolean;
    /** A module loaded from under this root that changed after the start makes the service exit once no call runs. */
    sourceRoot?: string;
    onStopped?: (reason: string) => void;
    /** How long a second start waits for a rival start's service.json (tests shorten it). */
    rivalWaitMs?: number;
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
 * the first and answers `running`), listens on `<dir>/service.sock`, and writes `service.json`.
 */
export async function startServiceHost<S>(options: ServiceHostOptions<S>): Promise<ServiceHostStart<S>> {
    const { dir } = options;
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
                log.info({ dir, pid: entry.pid, label: options.label }, "the service runs already");
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
    const socket = serviceSocketPath(dir);
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
        log.info({ reason, label, connections: server?.connections.length }, "service stopping");
        server?.endConnections();

        try {
            withPathArbitrationSync(socket, removeFiles);
        } catch (error) {
            log.warn({ error, socket }, "service socket lock busy; removing without it");
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
        });
        // Only the owner may connect, also where the folder's mode is not checked on the way in.
        chmodSync(socket, 0o600);
        atomicWriteFileSync(entryPath, SafeJSON.stringify(entry, null, 2));
        return listening;
    });

    const check = setInterval(() => {
        const busy = callsRunning > 0 || options.busy?.() === true;

        if (!codeIsCurrent()) {
            if (busy) {
                log.info({ calls: callsRunning, label }, "service code changed; exiting once no call runs");
                return;
            }

            log.info({ label }, "service code changed since start; exiting so the next caller starts the new code");
            stop("code-changed");
            return;
        }

        const idleMs = options.idleMs;

        if (idleMs > 0 && !busy && (server?.connections.length ?? 0) === 0 && Date.now() - lastBusy >= idleMs) {
            stop("idle");
        }
    }, options.checkEveryMs ?? CHECK_EVERY_MS);
    log.info({ dir, socket, pid: process.pid, label }, "service listening");

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
    timeoutMs?: number;
}): Promise<ServiceLaunch> {
    const { dir, label } = options;
    const running = readLiveServiceEntry(dir);

    if (running) {
        return { status: "running", entry: running };
    }

    mkdirSync(options.gates, { recursive: true });
    sweepStartGates(options.gates, START_GATE_MAX_AGE_MS);
    const gate = startGatePath(options.gates);
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
    log.info({ gate, label }, "starting the service");
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
                    log.warn({ pid: target, gate, label }, "the service passed its start but never listened");
                    // pid-verified: stopPassedChild calls this only after inspectPidFile confirmed the gate's writer is this live process
                    process.kill(target, "SIGTERM");
                },
            });
        },
    });

    if (outcome.status === "started") {
        log.info({ pid: outcome.value.pid, ms: Date.now() - startedAt, label }, "the service started");
        return { status: "started", entry: outcome.value };
    }

    const reason = `the ${label} did not start within ${(timeoutMs + START_GRACE_MS) / 1000} s (${outcome.status}); run ${toolCommand(options.command.join(" "))} in a terminal to see why`;
    log.warn({ status: outcome.status, ms: Date.now() - startedAt }, reason);
    return { status: "failed", reason };
}

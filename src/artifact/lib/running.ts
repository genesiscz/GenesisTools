import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, type PidIdentity, readProcessCommand } from "@genesiscz/utils/process-identity";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { runningPath } from "./storage";

export interface RunningServer {
    pid: number;
    port: number;
    dir: string;
    name: string;
    startedAt: string;
    /**
     * The registering process's own command line, captured at write time. A pid
     * on its own cannot be trusted after the process exits: the OS reissues it,
     * and `ps` was already handing pid 4242 to something unrelated. This is what
     * lets a later reader tell OUR server from a recycled pid before signalling it.
     */
    command?: string;
}

interface RunningFile {
    servers: RunningServer[];
}

/**
 * Alive AND still the process we registered. `classifyPid` owns the
 * ESRCH-vs-EPERM distinction plus the command-line comparison, so a recycled pid
 * reads as `foreign` rather than as a live server of ours.
 *
 * A record written before `command` existed classifies as `unverified`, which is
 * treated as alive: dropping those would silently forget servers across an upgrade.
 */
function isOurs(server: Pick<RunningServer, "pid" | "command">): boolean {
    return keepsRecord(classifyPid(server.pid, server.command));
}

function keepsRecord(identity: PidIdentity): boolean {
    if (identity.status === "foreign") {
        logger.debug({ pid: identity.pid, command: identity.command }, "[artifact] pid was recycled; not our server");
    }

    return identity.status !== "dead" && identity.status !== "foreign";
}

/** True only for a pid that is safe to SIGTERM: alive, and verifiably ours. */
export function isSignalable(identity: PidIdentity): boolean {
    return identity.status === "live";
}

function lockPath(): string {
    // withFileLock writes its pid record TO the given path — never lock the data file itself.
    return `${runningPath()}.lock`;
}

function readAll(): RunningServer[] {
    const path = runningPath();

    if (!existsSync(path)) {
        return [];
    }

    const raw = SafeJSON.parse(readFileSync(path, "utf8")) as RunningFile | null;

    return raw?.servers ?? [];
}

function writeAll(servers: RunningServer[]): void {
    atomicWriteFileSync(runningPath(), `${SafeJSON.stringify({ servers }, null, 4)}\n`);
}

/**
 * Live servers only. Filters in memory and writes NOTHING.
 *
 * It used to prune dead pids by rewriting the file, and outside the lock that
 * recordRunning and removeRunning both take — so `tools artifact ps` mutated
 * durable state and could clobber the record of a serve that was starting
 * concurrently. It was redundant as well as racy: recordRunning already drops
 * dead entries under the lock on every write.
 */
export function listRunning(): RunningServer[] {
    return liveRecords().map((match) => match.server);
}

export interface RunningMatch {
    server: RunningServer;
    /** The identity established while filtering — never classify the same pid twice. */
    identity: PidIdentity;
}

function liveRecords(): RunningMatch[] {
    return readAll()
        .map((server) => ({ server, identity: classifyPid(server.pid, server.command) }))
        .filter((match) => keepsRecord(match.identity));
}

export async function recordRunning(server: RunningServer): Promise<void> {
    // Capture the identity at write time; a later reader has no other way to
    // know what this pid was supposed to be.
    const withIdentity: RunningServer = {
        ...server,
        command: server.command ?? readProcessCommand(server.pid) ?? undefined,
    };
    // Concurrent serves start together (serve + library) — lock the
    // read-modify-write so one record cannot clobber the other.
    await withFileLock(lockPath(), async () => {
        const alive = readAll().filter((s) => isOurs(s) && s.pid !== server.pid);
        alive.push(withIdentity);
        writeAll(alive);
    });
}

export async function removeRunning(pid: number): Promise<void> {
    await withFileLock(lockPath(), async () => {
        writeAll(readAll().filter((s) => s.pid !== pid));
    });
}

/**
 * Match by registry name, directory, or port. Returns the pid identity the scan
 * already computed, so a caller deciding whether to signal does not re-probe.
 */
export function findRunning(target: string): RunningMatch | undefined {
    const port = Number.parseInt(target, 10);

    return liveRecords().find(
        ({ server: s }) => s.name === target || s.dir === target || (Number.isInteger(port) && s.port === port)
    );
}

export interface HoldServerOptions {
    /** The port the server actually bound. */
    port: number;
    /** Served folder, or a label like "(library)" for servers that serve many. */
    dir: string;
    /** Registry name, used by `tools artifact stop <name>`. */
    name: string;
    /** Shut the underlying server down. Called once, on SIGINT or SIGTERM. */
    close: () => Promise<void>;
    /** Opened with `open` on darwin when set. */
    openUrl?: string;
}

/**
 * Own the lifetime of a foreground server, the one way for every start path.
 *
 * Records it so `ps`/`stop` can find it, closes it on SIGINT/SIGTERM before the
 * process leaves (Vite holds file watchers, the HTTP listener and HMR sockets,
 * and closing first lets them unwind instead of being torn down by exit()),
 * drops the record, then blocks forever. NEVER resolves: the process leaves
 * through the signal path.
 *
 * `serve --detach` needs nothing extra — it re-spawns itself without `--detach`,
 * so the detached child comes back through this same function.
 */
export async function holdServer(options: HoldServerOptions): Promise<never> {
    await recordRunning({
        pid: process.pid,
        port: options.port,
        dir: options.dir,
        name: options.name,
        startedAt: new Date().toISOString(),
    });

    const cleanup = (): void => {
        void options
            .close()
            .catch((err: unknown) => {
                logger.debug({ err, name: options.name }, "[artifact] closing the server failed on shutdown");
            })
            .then(() => removeRunning(process.pid))
            .finally(() => process.exit(0));
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    if (options.openUrl && process.platform === "darwin") {
        Bun.spawn(["open", options.openUrl], { stdout: "ignore", stderr: "ignore" });
    }

    return new Promise<never>(() => {});
}

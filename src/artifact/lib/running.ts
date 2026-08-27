import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
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
    const identity = classifyPid(server.pid, server.command);

    if (identity.status === "foreign") {
        logger.debug({ pid: server.pid, command: identity.command }, "[artifact] pid was recycled; not our server");
    }

    return identity.status !== "dead" && identity.status !== "foreign";
}

/** True only for a pid that is safe to SIGTERM: alive, and verifiably ours. */
export function isSignalable(server: Pick<RunningServer, "pid" | "command">): boolean {
    return classifyPid(server.pid, server.command).status === "live";
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

/** Live servers only; dead pids are pruned from the file as a side effect. */
export function listRunning(): RunningServer[] {
    const all = readAll();
    const alive = all.filter(isOurs);

    if (alive.length !== all.length) {
        writeAll(alive);
    }

    return alive;
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

/** Match by registry name, directory, or port. */
export function findRunning(target: string): RunningServer | undefined {
    const port = Number.parseInt(target, 10);

    return listRunning().find(
        (s) => s.name === target || s.dir === target || (Number.isInteger(port) && s.port === port)
    );
}

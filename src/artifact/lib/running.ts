import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { runningPath } from "./storage";

export interface RunningServer {
    pid: number;
    port: number;
    dir: string;
    name: string;
    startedAt: string;
}

interface RunningFile {
    servers: RunningServer[];
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (err) {
        // EPERM = the process exists but we may not signal it — still alive.
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
            return true;
        }

        logger.debug({ err, pid }, "[artifact] pid liveness probe");

        return false;
    }
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
    const alive = all.filter((s) => isAlive(s.pid));

    if (alive.length !== all.length) {
        writeAll(alive);
    }

    return alive;
}

export async function recordRunning(server: RunningServer): Promise<void> {
    // Concurrent serves start together (serve + library) — lock the
    // read-modify-write so one record cannot clobber the other.
    await withFileLock(lockPath(), async () => {
        const alive = readAll().filter((s) => isAlive(s.pid) && s.pid !== server.pid);
        alive.push(server);
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

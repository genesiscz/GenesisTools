import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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
        logger.debug({ err, pid }, "[artifact] pid liveness probe");

        return false;
    }
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

export function recordRunning(server: RunningServer): void {
    const alive = listRunning().filter((s) => s.pid !== server.pid);
    alive.push(server);
    writeAll(alive);
}

export function removeRunning(pid: number): void {
    writeAll(readAll().filter((s) => s.pid !== pid));
}

/** Match by registry name, directory, or port. */
export function findRunning(target: string): RunningServer | undefined {
    const port = Number.parseInt(target, 10);

    return listRunning().find(
        (s) => s.name === target || s.dir === target || (Number.isInteger(port) && s.port === port)
    );
}

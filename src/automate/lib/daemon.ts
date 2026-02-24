import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@app/logger";
import { closeDb, getDb } from "./db";
import { runSchedulerLoop } from "./scheduler";

const PID_FILE = join(homedir(), ".genesis-tools", "automate", "daemon.pid");

export async function startDaemon(): Promise<void> {
    const log = createLogger({ logToFile: false });
    writeFileSync(PID_FILE, String(process.pid));
    log.info({ pid: process.pid }, "Automate daemon starting");

    const db = getDb();
    const cleanup = () => {
        closeDb();
        if (existsSync(PID_FILE)) {
            unlinkSync(PID_FILE);
        }
        log.info("Daemon stopped");
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    try {
        await runSchedulerLoop(db);
    } catch (err) {
        log.error({ err }, "Daemon crashed");
    } finally {
        cleanup();
    }
}

export function getDaemonPid(): number | null {
    if (!existsSync(PID_FILE)) {
        return null;
    }
    try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        try {
            process.kill(pid, 0);
            return pid;
        } catch {
            return null;
        }
    } catch {
        return null;
    }
}

if (import.meta.main) {
    startDaemon();
}

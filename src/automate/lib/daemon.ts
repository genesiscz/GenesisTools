import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@app/logger";
import { closeDb, getDb } from "./db";
import { runSchedulerLoop } from "./scheduler";

const PID_FILE = join(homedir(), ".genesis-tools", "automate", "daemon.pid");

export async function startDaemon(): Promise<void> {
    const log = createLogger({ logToFile: false });

    try {
        await writeFile(PID_FILE, String(process.pid), { flag: "wx" });
    } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = getDaemonPid();

            if (existing !== null) {
                log.error({ existingPid: existing }, "Another automate daemon is already running");
                process.exit(1);
            }

            unlinkSync(PID_FILE);
            await writeFile(PID_FILE, String(process.pid), { flag: "wx" });
        } else {
            throw err;
        }
    }

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
        } catch (err) {
            if (process.platform === "win32" && err instanceof Error && "code" in err) {
                return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
            }

            return null;
        }
    } catch {
        return null;
    }
}

if (import.meta.main) {
    startDaemon();
}

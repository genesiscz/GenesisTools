import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "@app/logger";
import { getLogsBaseDir, getPidFile } from "./lib/config";
import { runSchedulerLoop } from "./lib/scheduler";

const log = createLogger({ logToFile: false });

export async function startDaemon(): Promise<void> {
    const pidFile = getPidFile();
    mkdirSync(dirname(pidFile), { recursive: true });

    try {
        await writeFile(pidFile, String(process.pid), { flag: "wx" });
    } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = getDaemonPid();

            if (existing !== null) {
                log.error({ existingPid: existing }, "Another daemon is already running");
                process.exit(1);
            }

            unlinkSync(pidFile);
            await writeFile(pidFile, String(process.pid), { flag: "wx" });
        } else {
            throw err;
        }
    }

    log.info({ pid: process.pid }, "Daemon starting");

    const cleanup = () => {
        if (existsSync(pidFile)) {
            unlinkSync(pidFile);
        }

        log.info("Daemon stopped");
    };

    try {
        await runSchedulerLoop(getLogsBaseDir());
    } catch (err) {
        log.error({ err }, "Daemon crashed");
    } finally {
        cleanup();
    }
}

export function getDaemonPid(): number | null {
    const pidFile = getPidFile();

    if (!existsSync(pidFile)) {
        return null;
    }

    try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

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

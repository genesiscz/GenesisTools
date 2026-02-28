import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createLogger } from "@app/logger";
import { getLogsBaseDir, getPidFile } from "./lib/config";
import { runSchedulerLoop } from "./lib/scheduler";

const log = createLogger({ logToFile: false });

export async function startDaemon(): Promise<void> {
    const pidFile = getPidFile();
    writeFileSync(pidFile, String(process.pid));
    log.info({ pid: process.pid }, "Daemon starting");

    const cleanup = () => {
        if (existsSync(pidFile)) {
            unlinkSync(pidFile);
        }

        log.info("Daemon stopped");
    };

    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);

    try {
        await runSchedulerLoop(getLogsBaseDir());
    } catch (err) {
        log.error({ err }, "Daemon crashed");
    } finally {
        process.off("SIGTERM", cleanup);
        process.off("SIGINT", cleanup);
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

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearPortFile, SERVER_BASE_DIR } from "@app/youtube/lib/server/port-file";
import { logger } from "@genesiscz/utils/logger";
import { clearPidFile, readLivePid, writePidFile } from "@genesiscz/utils/process/pidfile";

export const PID_FILE = join(SERVER_BASE_DIR, "server.pid");

export interface PidFileOptions {
    pidFile?: string;
}

export function writePid({ pid = process.pid, pidFile = PID_FILE }: { pid?: number } & PidFileOptions = {}): void {
    const directory = dirname(pidFile);

    if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
    }

    writePidFile(pidFile, { pid });
}

/**
 * The server's pid when it is still running, else null. The record written by
 * `writePid` carries the owner's command line, so a pid the kernel later
 * recycled onto an unrelated program reads as stale rather than as our server.
 */
export function readPid({ pidFile = PID_FILE }: PidFileOptions = {}): number | null {
    return readLivePid(pidFile);
}

/** Unconditional: the caller clears stale records it does not own. */
export function clearPid({ pidFile = PID_FILE }: PidFileOptions = {}): void {
    clearPidFile(pidFile, { force: true });
}

export function registerSignalHandlers(onShutdown: () => Promise<void> | void): void {
    let shuttingDown = false;
    const handler = async (): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        try {
            await onShutdown();
        } catch (err) {
            logger.error({ err }, "youtube server shutdown failed");
        } finally {
            clearPid();
            clearPortFile();
            process.exit(0);
        }
    };

    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
}

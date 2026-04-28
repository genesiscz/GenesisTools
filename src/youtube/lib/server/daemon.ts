import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import logger from "@app/logger";
import { clearPortFile, SERVER_BASE_DIR } from "@app/youtube/lib/server/port-file";

export const PID_FILE = join(SERVER_BASE_DIR, "server.pid");

export interface PidFileOptions {
    pidFile?: string;
}

export function writePid({ pid = process.pid, pidFile = PID_FILE }: { pid?: number } & PidFileOptions = {}): void {
    const directory = dirname(pidFile);

    if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
    }

    writeFileSync(pidFile, String(pid));
}

export function readPid({ pidFile = PID_FILE }: PidFileOptions = {}): number | null {
    if (!existsSync(pidFile)) {
        return null;
    }

    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

    if (Number.isNaN(pid)) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return pid;
    } catch (err) {
        if (process.platform === "win32" && err instanceof Error && "code" in err) {
            return err.code === "EPERM" ? pid : null;
        }

        return null;
    }
}

export function clearPid({ pidFile = PID_FILE }: PidFileOptions = {}): void {
    if (existsSync(pidFile)) {
        unlinkSync(pidFile);
    }
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

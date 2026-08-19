import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { createLogger } from "@genesiscz/utils/logger";
import { clearPidFile, readLivePid, writePidFile } from "@genesiscz/utils/process/pidfile";
import { closeDb, getDb } from "./db";
import { runSchedulerLoop } from "./scheduler";

const PID_FILE = join(env.tools.getHome(), ".genesis-tools", "automate", "daemon.pid");

/**
 * True when a command line is recognisably an automate daemon. Only used to
 * judge legacy bare-number pidfiles; files written by {@link writePidFile}
 * carry the owner's own command line, which is the stronger signal.
 */
export function isAutomateDaemonCommand(command: string): boolean {
    const normalized = command.replace(/\\/g, "/");

    if (/(^|[\s/])automate\/lib\/daemon\.tsx?(\s|$)/.test(normalized)) {
        return true;
    }

    // `tools automate daemon start` runs the loop in-process from the tool
    // entrypoint, so the `daemon` token is what separates it from every other
    // short-lived `tools automate …` invocation.
    return /(^|[\s/])(automate\/index\.tsx?|tools\s+automate)(\s|$)/.test(normalized) && /\bdaemon\b/.test(normalized);
}

export async function startDaemon(): Promise<void> {
    const log = createLogger({ logToFile: false });

    try {
        writePidFile(PID_FILE, { exclusive: true });
    } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = getDaemonPid();

            if (existing !== null) {
                log.error({ existingPid: existing }, "Another automate daemon is already running");
                process.exit(1);
            }

            // Nothing live owns it — the pid is gone, or was recycled onto an
            // unrelated program (see the incidents in the pidfile module).
            clearPidFile(PID_FILE, { force: true });
            writePidFile(PID_FILE, { exclusive: true });
        } else {
            throw err;
        }
    }

    log.info({ pid: process.pid }, "Automate daemon starting");

    const db = getDb();
    const cleanup = () => {
        closeDb();
        clearPidFile(PID_FILE);
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
    return readLivePid(PID_FILE, { expected: isAutomateDaemonCommand });
}

if (import.meta.main) {
    startDaemon();
}

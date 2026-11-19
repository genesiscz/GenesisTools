import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { out } from "@genesiscz/utils/logger";

export interface PrivateWatchman {
    sock: string;
    /** The daemon's pid from its pid file, null when the file is missing or unreadable. */
    pid(): number | null;
    stop(): void;
}

/**
 * A private Watchman daemon for one benchmark run (its own socket, state, log and pid file under `scratch`), so a run
 * never touches the user's watches. A child reaches it through `WATCHMAN_SOCK`. Null when Watchman is not installed
 * or did not start.
 */
export function startPrivateWatchman(scratch: string): PrivateWatchman | null {
    const binary = Bun.which("watchman");

    if (!binary) {
        return null;
    }

    const sock = join(scratch, "watchman.sock");
    const pidFile = join(scratch, "watchman.pid");
    const flags = [
        `--sockname=${sock}`,
        `--statefile=${join(scratch, "watchman.state")}`,
        `--logfile=${join(scratch, "watchman.log")}`,
        `--pidfile=${pidFile}`,
    ];
    const started = Bun.spawnSync([binary, ...flags, "--no-save-state", "get-sockname"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
    });

    if (started.exitCode !== 0) {
        out.println(`watchman did not start: ${started.stderr.toString().slice(0, 300)}`);
        return null;
    }

    return {
        sock,
        pid: () => {
            if (!existsSync(pidFile)) {
                return null;
            }

            const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
            return Number.isInteger(pid) && pid > 0 ? pid : null;
        },
        stop: () => {
            Bun.spawnSync([binary, `--sockname=${sock}`, "shutdown-server"], {
                stdout: "pipe",
                stderr: "pipe",
                timeout: 10_000,
            });
        },
    };
}

import { logger } from "@genesiscz/utils/logger";
import { parsePidLines } from "@genesiscz/utils/network";

function readPidsOnPort(port: number): number[] {
    const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (result.exitCode !== 0) {
        return [];
    }

    return parsePidLines(new TextDecoder().decode(result.stdout));
}

function commandForPid(pid: number): string {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (result.exitCode !== 0) {
        return "";
    }

    return new TextDecoder().decode(result.stdout).trim();
}

/**
 * A DashboardApp ui-server process runs the tool entry with the framework's
 * hidden `__ui-server` command (see viteSpawn). We additionally require a
 * tool-specific `commandMatch` token (e.g. the tool label / server-script
 * path) so we only ever kill *this* tool's orphaned ui-server, never another.
 */
function isUiServerCommand(command: string, commandMatch: string): boolean {
    return command.includes(commandMatch) && command.includes("__ui-server");
}

function childPids(parentPid: number): number[] {
    const result = Bun.spawnSync(["pgrep", "-P", String(parentPid)], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (result.exitCode !== 0) {
        return [];
    }

    return parsePidLines(new TextDecoder().decode(result.stdout));
}

export interface StopUiServerOptions {
    /**
     * Substring identifying this tool's ui-server process command — typically
     * the tool label or server-script path (e.g. "dev-dashboard"). Combined
     * with the framework's `__ui-server` marker to avoid killing other tools.
     */
    commandMatch: string;
}

/**
 * Stops a prior DashboardApp `__ui-server` still bound to the public port
 * (avoids an orphaned front-proxy when the tool restarts). Shared across
 * dashboards via the preview server's `beforeListen` hook.
 */
export function stopUiServerOnPort(publicPort: number, opts: StopUiServerOptions): void {
    const listeners = readPidsOnPort(publicPort);

    for (const pid of listeners) {
        const command = commandForPid(pid);

        if (!isUiServerCommand(command, opts.commandMatch)) {
            logger.warn({ pid, publicPort, command }, "port in use by non-dashboard process; not killing");
            continue;
        }

        // warn, not info: under launchd KeepAlive this kill is answered by an
        // immediate respawn, so a second starter takes the public port down for a
        // full rebuild. When that is the cause of a 502, this line is the only
        // evidence, and it has to be findable at the default console level.
        logger.warn({ pid, publicPort, command }, "stopping previous dashboard ui-server");

        const children = childPids(pid);

        for (const childPid of children) {
            try {
                // pid-verified: parent verified by isUiServerCommand's live ps read; children came from pgrep -P on it in the same pass
                process.kill(childPid, "SIGTERM");
            } catch (err) {
                logger.debug({ err, childPid }, "failed to stop dashboard vite child");
            }
        }

        // pid-verified: same live ps verification as the child kill above
        try {
            // pid-verified: same live ps verification as the child kill above
            process.kill(pid, "SIGTERM");
        } catch (err) {
            logger.debug({ err, pid }, "failed to stop dashboard ui-server");
        }
    }

    if (listeners.length > 0) {
        Bun.sleepSync(400);
    }
}

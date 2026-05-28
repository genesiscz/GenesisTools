import { logger } from "@app/logger";

function readPidsOnPort(port: number): number[] {
    const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (result.exitCode !== 0) {
        return [];
    }

    const text = new TextDecoder().decode(result.stdout).trim();

    if (!text) {
        return [];
    }

    return text
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
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

function isDevDashboardUiServerCommand(command: string): boolean {
    return command.includes("dev-dashboard") && command.includes("__ui-server");
}

function childPids(parentPid: number): number[] {
    const result = Bun.spawnSync(["pgrep", "-P", String(parentPid)], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (result.exitCode !== 0) {
        return [];
    }

    const text = new TextDecoder().decode(result.stdout).trim();

    if (!text) {
        return [];
    }

    return text
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/** Stops a prior dev-dashboard __ui-server still bound to the public port (avoids orphan proxy). */
export function stopUiServerOnPort(publicPort: number): void {
    const listeners = readPidsOnPort(publicPort);

    for (const pid of listeners) {
        const command = commandForPid(pid);

        if (!isDevDashboardUiServerCommand(command)) {
            logger.warn({ pid, publicPort, command }, "port in use by non-dashboard process; not killing");
            continue;
        }

        logger.info({ pid, publicPort }, "stopping previous dev-dashboard ui-server");

        const children = childPids(pid);

        for (const childPid of children) {
            try {
                process.kill(childPid, "SIGTERM");
            } catch (err) {
                logger.debug({ err, childPid }, "failed to stop dev-dashboard vite child");
            }
        }

        try {
            process.kill(pid, "SIGTERM");
        } catch (err) {
            logger.debug({ err, pid }, "failed to stop dev-dashboard ui-server");
        }
    }

    if (listeners.length > 0) {
        Bun.sleepSync(400);
    }
}

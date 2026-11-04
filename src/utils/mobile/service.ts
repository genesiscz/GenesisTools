import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { logger } from "@genesiscz/utils/logger";
import { clearPidFile, inspectPidFile, type PidFileState, writePidFile } from "@genesiscz/utils/process/pidfile";

const log = logger.child({ component: "mobile.service" });

/**
 * A background server a mobile command starts and later stops (an Appium server, Metro): detached into its own
 * process group, its output appended to a log, its pid in a pidfile that records the process start time, so a stop
 * never signals a pid the OS has since given to another program.
 */
export interface DetachedService {
    name: string;
    command: string[];
    cwd: string;
    environment?: Record<string, string | undefined>;
    logPath: string;
    pidPath: string;
    /** A word the service's command line contains; a pidfile whose pid now runs something else reads as foreign. */
    expect: string;
}

export function serviceState(service: Pick<DetachedService, "pidPath" | "expect">): PidFileState {
    return inspectPidFile(service.pidPath, { expected: (command) => command.includes(service.expect) });
}

/** Starts the service and waits until `ready()` answers true; throws with the log tail when it exits or times out. */
export async function startDetached(
    service: DetachedService,
    options: { ready: () => Promise<boolean>; timeoutMs: number }
): Promise<number> {
    mkdirSync(dirname(service.logPath), { recursive: true });
    mkdirSync(dirname(service.pidPath), { recursive: true });
    const fd = openSync(service.logPath, "a");
    const [file, ...args] = service.command;
    const child = spawn(file, args, {
        cwd: service.cwd,
        env: service.environment,
        detached: true,
        stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.unref();

    if (!child.pid) {
        throw new Error(`${service.name} did not start: ${service.command.join(" ")}`);
    }

    log.info(
        { name: service.name, pid: child.pid, command: service.command.join(" "), log: service.logPath },
        "started"
    );

    const deadline = Date.now() + options.timeoutMs;
    let exited = false;
    child.once("exit", () => {
        exited = true;
    });

    while (Date.now() < deadline) {
        if (await options.ready()) {
            // Written once it answers: a launcher (`bunx`, `env`) re-executes into the real program, and a record of the
            // first command line would read as a foreign process ever after.
            writePidFile(service.pidPath, { pid: child.pid });
            return child.pid;
        }

        if (exited) {
            clearPidFile(service.pidPath, { force: true });
            throw new Error(`${service.name} exited during start-up:\n${logTail(service.logPath)}`);
        }

        await Bun.sleep(500);
    }

    throw new Error(
        `${service.name} did not answer within ${options.timeoutMs / 1000} s (pid ${child.pid}):\n${logTail(service.logPath)}`
    );
}

/** Stops a service this tool started: SIGTERM to its process group, SIGKILL after `graceMs`. False when none ran. */
export async function stopDetached(
    service: Pick<DetachedService, "name" | "pidPath" | "expect">,
    graceMs = 5_000
): Promise<boolean> {
    const state = serviceState(service);

    if (state.status !== "live") {
        clearPidFile(service.pidPath, { force: true });
        log.debug({ name: service.name, state: state.status }, "nothing to stop");
        return false;
    }

    const signal = (name: NodeJS.Signals) => {
        try {
            process.kill(-state.pid, name);
        } catch (error) {
            log.debug({ pid: state.pid, signal: name, error }, "group signal failed, signalling the pid");
            try {
                process.kill(state.pid, name);
            } catch (inner) {
                log.debug({ pid: state.pid, signal: name, error: inner }, "signal failed");
            }
        }
    };

    signal("SIGTERM");
    const deadline = Date.now() + graceMs;

    while (Date.now() < deadline && serviceState(service).status === "live") {
        await Bun.sleep(200);
    }

    if (serviceState(service).status === "live") {
        signal("SIGKILL");
    }

    clearPidFile(service.pidPath, { force: true });
    log.info({ name: service.name, pid: state.pid }, "stopped");
    return true;
}

export function logTail(path: string, lines = 15): string {
    try {
        return readLastLines(path, { maxBytes: 16_384 }).lines.slice(-lines).join("\n");
    } catch (error) {
        log.debug({ path, error }, "no log to read");
        return "(no log)";
    }
}

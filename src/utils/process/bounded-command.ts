import { spawn } from "node:child_process";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { argvWithChildDeadline } from "./child-deadline";

export interface BoundedCommandResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: Error & { code?: string };
}
export async function boundedCommand(options: {
    command: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    maxBufferBytes?: number;
    cwd?: string;
}): Promise<BoundedCommandResult> {
    options.signal?.throwIfAborted();
    const timeoutMs = Math.floor(options.timeoutMs);
    const maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024;
    if (
        !options.command.length ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2147483647 ||
        !Number.isSafeInteger(maxBufferBytes) ||
        maxBufferBytes < 1 ||
        maxBufferBytes > 64 * 1024 * 1024
    ) {
        throw new Error("Invalid bounded command, deadline or output budget.");
    }
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            const command = argvWithChildDeadline(options.command, timeoutMs);
            child = spawn(command[0], command.slice(1), {
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
                cwd: options.cwd,
                env: env.getProcessEnv(),
            });
        } catch (error) {
            resolve({
                status: null,
                signal: null,
                stdout: "",
                stderr: "",
                error: error instanceof Error ? error : new Error("Spawn failed."),
            });
            return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let failure: BoundedCommandResult["error"];
        let settled = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let reap: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => {
            if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
                return;
            }
            try {
                // pid-verified: retained live child handle, spawned here as leader of this detached process group.
                process.kill(-child.pid, signal);
            } catch (error) {
                logger.debug({ error, pid: child.pid, signal }, "Owned command group already ended");
            }
        };
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            clearTimeout(escalation);
            clearTimeout(reap);
            options.signal?.removeEventListener("abort", cancel);
            resolve({
                status: child.exitCode,
                signal: child.signalCode,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                error: failure,
            });
        };
        const stop = (error: Error & { code?: string }) => {
            if (failure || settled) {
                return;
            }
            failure = error;
            kill("SIGTERM");
            escalation = setTimeout(() => {
                kill("SIGKILL");
                reap = setTimeout(() => {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    finish();
                }, 500);
            }, 100);
        };
        const cancel = () =>
            stop(
                Object.assign(new Error("Command cancelled; any in-flight mutation has unknown outcome."), {
                    code: "ABORT_ERR",
                })
            );
        const deadline = setTimeout(
            () => stop(Object.assign(new Error("Command deadline reached."), { code: "ETIMEDOUT" })),
            timeoutMs
        );
        child.stdout?.on("data", (value: Buffer) => {
            if (failure || settled) {
                return;
            }
            stdoutBytes += value.byteLength;
            if (stdoutBytes > maxBufferBytes) {
                stop(Object.assign(new Error("Command stdout exceeded its byte budget."), { code: "ENOBUFS" }));
                return;
            }
            stdout.push(value);
        });
        child.stderr?.on("data", (value: Buffer) => {
            if (failure || settled) {
                return;
            }
            stderrBytes += value.byteLength;
            if (stderrBytes > maxBufferBytes) {
                stop(Object.assign(new Error("Command stderr exceeded its byte budget."), { code: "ENOBUFS" }));
                return;
            }
            stderr.push(value);
        });
        child.stdout?.once("error", stop);
        child.stderr?.once("error", stop);
        child.once("error", stop);
        child.once("close", finish);
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) {
            cancel();
        }
    });
}

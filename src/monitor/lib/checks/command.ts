import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher } from "../types";

const MAX_OUTPUT = 4_000;

function lastLine(text: string): string {
    const lines = text
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    return lines.at(-1) ?? "";
}

/**
 * Runs a shell command; exit 0 is up, anything else is down. The last output
 * line lands in the detail, so a script can explain its own verdict.
 */
export async function checkCommand(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    const started = performance.now();
    const proc = Bun.spawn(["sh", "-c", watcher.target], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, watcher.timeoutMs);

    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const latencyMs = Math.round(performance.now() - started);
        const output = `${stdout}\n${stderr}`.slice(-MAX_OUTPUT);
        const tail = lastLine(stderr) || lastLine(stdout);
        const meta = { exitCode, output: output.trim().slice(-800) };

        if (timedOut) {
            return {
                status: "down",
                latencyMs,
                httpStatus: null,
                detail: `killed after ${Math.round(watcher.timeoutMs / 1000)} s${tail ? ` · ${tail}` : ""}`,
                meta,
            };
        }

        if (exitCode !== 0) {
            logger.debug({ exitCode, tail, target: watcher.target }, "monitor: command check failed");

            return {
                status: "down",
                latencyMs,
                httpStatus: null,
                detail: `exit ${exitCode}${tail ? ` · ${tail}` : ""}`,
                meta,
            };
        }

        const threshold = watcher.config.degradedAboveMs;

        if (threshold !== undefined && latencyMs > threshold) {
            return {
                status: "degraded",
                latencyMs,
                httpStatus: null,
                detail: `exit 0 · ${latencyMs} ms (slower than ${threshold} ms)${tail ? ` · ${tail}` : ""}`,
                meta,
            };
        }

        return {
            status: "up",
            latencyMs,
            httpStatus: null,
            detail: `exit 0 · ${latencyMs} ms${tail ? ` · ${tail}` : ""}`,
            meta,
        };
    } finally {
        clearTimeout(timer);
    }
}

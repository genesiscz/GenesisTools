import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
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
    const result = await boundedCommand({
        command: ["sh", "-c", watcher.target],
        timeoutMs: watcher.timeoutMs,
        maxBufferBytes: 256 * 1024,
    });
    const latencyMs = Math.round(performance.now() - started);
    const output = `${result.stdout}\n${result.stderr}`.slice(-MAX_OUTPUT);
    const tail = lastLine(result.stderr) || lastLine(result.stdout);
    const exitCode = result.status ?? 1;
    const meta = { exitCode, output: output.trim().slice(-800) };

    if (result.error?.code === "ETIMEDOUT") {
        return {
            status: "down",
            latencyMs,
            httpStatus: null,
            detail: `killed after ${Math.round(watcher.timeoutMs / 1000)} s${tail ? ` · ${tail}` : ""}`,
            meta,
        };
    }

    if (result.error) {
        logger.debug({ error: result.error, target: watcher.target }, "monitor: command check failed");
        return {
            status: "down",
            latencyMs,
            httpStatus: null,
            detail: `${result.error.code === "ENOBUFS" ? "output limit exceeded" : result.error.message}${tail ? ` · ${tail}` : ""}`,
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
}

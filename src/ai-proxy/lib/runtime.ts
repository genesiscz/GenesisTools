import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyRuntimeState } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

function ensureParentDir(filePath: string): void {
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export async function readRuntimeState(): Promise<AiProxyRuntimeState> {
    const storage = getAiProxyStorage();
    const path = storage.runtimePath();

    if (!existsSync(path)) {
        return {};
    }

    try {
        const raw = await Bun.file(path).text();
        return SafeJSON.parse(raw) as AiProxyRuntimeState;
    } catch (err) {
        logger.warn({ err, path }, "ai-proxy: failed to read runtime state");
        return {};
    }
}

export async function writeRuntimeState(state: AiProxyRuntimeState): Promise<void> {
    const storage = getAiProxyStorage();
    await storage.ensureDirs();
    await Bun.write(storage.runtimePath(), SafeJSON.stringify(state, null, 2));
}

export function writeProxyPid(pid: number): void {
    const path = getAiProxyStorage().proxyPidPath();
    ensureParentDir(path);
    writeFileSync(path, String(pid));
}

export function readProxyPid(): number | null {
    const path = getAiProxyStorage().proxyPidPath();

    if (!existsSync(path)) {
        return null;
    }

    const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        return null;
    }

    return pid;
}

export function clearProxyPid(): void {
    const path = getAiProxyStorage().proxyPidPath();

    if (existsSync(path)) {
        unlinkSync(path);
    }
}

/**
 * Read a pid's command line. Returns null when the OS can't tell us — Windows
 * (no `ps`), a `ps` failure, or a process that exited between the liveness
 * probe and this call.
 */
export function readProcessCommand(pid: number): string | null {
    if (process.platform === "win32") {
        return null;
    }

    try {
        const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
            stdout: "pipe",
            stderr: "pipe",
        });

        if (proc.exitCode !== 0) {
            return null;
        }

        const command = proc.stdout.toString().trim();
        return command.length > 0 ? command : null;
    } catch (err) {
        logger.debug({ err, pid }, "ai-proxy: ps lookup failed");
        return null;
    }
}

/**
 * True when a command line is recognisably an ai-proxy *serve* process.
 *
 * Both halves matter. The path segment rejects unrelated programs that happen
 * to take a `serve` subcommand (the real-world PID-reuse case was
 * `.../MacOS/darwinkit serve`), and the `serve` token rejects our own
 * short-lived `ai-proxy status` / `up` invocations.
 */
export function isAiProxyServeCommand(command: string): boolean {
    const normalized = command.replace(/\\/g, "/");

    if (!normalized.split(/\s+/).includes("serve")) {
        return false;
    }

    return /(^|[\s/])ai-proxy(\/index\.tsx?)?(\s|$)/.test(normalized);
}

export type ProxyPidState =
    /** No pid recorded — proxy was never started, or was stopped cleanly. */
    | { status: "none" }
    /** Alive and confirmed to be our proxy. */
    | { status: "live"; pid: number; command: string }
    /** Recorded but the process is gone. */
    | { status: "dead"; pid: number }
    /** Alive, but the pid now belongs to someone else (pid reuse). */
    | { status: "foreign"; pid: number; command: string }
    /** Alive, and the OS wouldn't tell us what it is. Assumed to be ours. */
    | { status: "unverified"; pid: number };

/**
 * Classify the recorded proxy pid. Read-only on purpose: `status` is a
 * diagnostic and must not repair anything. `up` / `down` call
 * {@link clearRuntimeState} themselves once they've decided what to do.
 */
export function inspectProxyPid(): ProxyPidState {
    const pid = readProxyPid();

    if (pid === null) {
        return { status: "none" };
    }

    if (!isProcessAlive(pid)) {
        return { status: "dead", pid };
    }

    const command = readProcessCommand(pid);
    if (command === null) {
        logger.debug({ pid }, "ai-proxy: could not read command line for recorded pid");
        return { status: "unverified", pid };
    }

    if (!isAiProxyServeCommand(command)) {
        logger.warn({ pid, command }, "ai-proxy: recorded pid belongs to another process (pid reuse)");
        return { status: "foreign", pid, command };
    }

    return { status: "live", pid, command };
}

export function resolveLiveProxyPid(): number | null {
    const state = inspectProxyPid();

    if (state.status === "live" || state.status === "unverified") {
        return state.pid;
    }

    return null;
}

export async function clearRuntimeState(): Promise<void> {
    clearProxyPid();

    const path = getAiProxyStorage().runtimePath();
    if (existsSync(path)) {
        unlinkSync(path);
    }
}

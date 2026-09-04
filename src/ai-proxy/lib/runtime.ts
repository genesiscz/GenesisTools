import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyRuntimeState } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";

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

/**
 * Record THIS process as the serving proxy. Returns false when it declined.
 *
 * `up` records the pid of the child it spawns, but on the launchd path there is
 * no such parent: launchd runs `serve` directly. Without this, `status` and
 * `down` would find no pid and report a healthy launchd-managed proxy as
 * stopped. Call it only once the listener is actually up, so a `serve` that
 * dies on a bound port never overwrites the live proxy's record.
 *
 * Both ports are required so no caller can register by accident. Only the
 * instance on the CONFIGURED port owns the record: a `serve --port <other>` used
 * to overwrite the launchd-managed proxy's pid, after which `status` reported
 * the debug pid while health-probing the real port, and a single `down` booted
 * out launchd and then SIGTERMed both.
 */
export async function registerServingProcess(ports: { serving: number; configured: number }): Promise<boolean> {
    if (ports.serving !== ports.configured) {
        logger.info(ports, "ai-proxy: not the configured port — leaving the proxy pid record alone");

        return false;
    }

    writeProxyPid(process.pid);

    const runtime = await readRuntimeState();
    runtime.proxy = { pid: process.pid, startedAt: new Date().toISOString() };
    await writeRuntimeState(runtime);

    return true;
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

    const identity = classifyPid(pid, isAiProxyServeCommand);

    if (identity.status === "foreign") {
        logger.warn(
            { pid, command: identity.command },
            "ai-proxy: recorded pid belongs to another process (pid reuse)"
        );
        return { status: "foreign", pid, command: identity.command ?? "(unknown)" };
    }

    if (identity.status === "live") {
        return { status: "live", pid, command: identity.command ?? "(unknown)" };
    }

    return { status: identity.status, pid };
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

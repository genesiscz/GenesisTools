import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyRuntimeState } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isProcessAlive } from "@app/utils/process-alive";

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

export function resolveLiveProxyPid(): number | null {
    const pid = readProxyPid();

    if (pid !== null && isProcessAlive(pid)) {
        return pid;
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

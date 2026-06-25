import { join } from "node:path";
import { getAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { ensurePublicExposure, verifyPublicExposure } from "@app/ai-proxy/lib/exposure";
import { buildLocalBaseUrl, buildPublicBaseUrl, resolveCursorBaseUrl } from "@app/ai-proxy/lib/public-url";
import {
    clearRuntimeState,
    readRuntimeState,
    resolveLiveProxyPid,
    writeProxyPid,
    writeRuntimeState,
} from "@app/ai-proxy/lib/runtime";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { probeUrl } from "@app/ai-proxy/lib/tunnel/cloudflared";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { scheduleBillingSyncForConfig } from "@app/ai-proxy/lib/usage/billing-sync";
import { logger, out } from "@app/logger";
import { spawnDetached } from "@app/utils/DashboardApp/detach";
import { waitForUrlReady } from "@app/utils/DashboardApp/readiness";
import { getPortOwner } from "@app/utils/network";
import { isProcessAlive } from "@app/utils/process-alive";

function proxyEntryPath(): string {
    return join(import.meta.dir, "..", "index.ts");
}

function toolsRoot(): string {
    return join(import.meta.dir, "..", "..", "..");
}

async function spawnProxy(config: AiProxyConfig): Promise<number> {
    const storage = getAiProxyStorage();
    const logFile = storage.proxyLogPath();
    const { pid } = spawnDetached({
        cmd: ["bun", "run", proxyEntryPath(), "serve", "--port", String(config.listen.port)],
        cwd: toolsRoot(),
        logFile,
    });

    if (!isProcessAlive(pid)) {
        throw new Error(`Failed to start ai-proxy — see ${logFile}`);
    }

    writeProxyPid(pid);

    const runtime = await readRuntimeState();
    runtime.proxy = {
        pid,
        startedAt: new Date().toISOString(),
    };
    await writeRuntimeState(runtime);

    return pid;
}

async function waitForLocalHealth(config: AiProxyConfig, attempts = 20): Promise<boolean> {
    const url = `http://${config.listen.host}:${config.listen.port}/health`;
    const ready = await waitForUrlReady(url, attempts * 250);
    return ready.ready;
}

export interface UpResult {
    started: boolean;
    pid?: number;
    message: string;
    localUrl: string;
    cursorUrl: string;
}

export async function runAiProxyUp(): Promise<UpResult> {
    const store = getAiProxyConfigStore();
    const config = await store.load();
    const localUrl = buildLocalBaseUrl(config);
    const cursorUrl = resolveCursorBaseUrl(config);

    const livePid = resolveLiveProxyPid();
    if (livePid !== null) {
        return {
            started: false,
            pid: livePid,
            message: `ai-proxy already running (pid ${livePid})`,
            localUrl,
            cursorUrl,
        };
    }

    const portOwner = await getPortOwner(config.listen.port);
    if (portOwner?.pid && isProcessAlive(portOwner.pid)) {
        return {
            started: false,
            pid: portOwner.pid,
            message: `Port ${config.listen.port} already in use by pid ${portOwner.pid} — not ai-proxy managed`,
            localUrl,
            cursorUrl,
        };
    }

    const pid = await spawnProxy(config);
    const healthy = await waitForLocalHealth(config);

    if (!healthy) {
        out.log.warn(
            `Local health check failed — proxy may still be starting. Logs: ${getAiProxyStorage().proxyLogPath()}`
        );
    } else {
        out.log.success(`ai-proxy listening on ${localUrl} (pid ${pid})`);
    }

    const exposure = await ensurePublicExposure(config);
    out.log.info(exposure.message);

    if (config.public?.mode && config.public.mode !== "none") {
        await Bun.sleep(exposure.started ? 2000 : 500);
        const verified = await verifyPublicExposure(config);

        if (verified) {
            if (verified.ok) {
                out.log.success(`Public health OK: ${verified.url}`);
            } else {
                out.log.warn(`Public health failed: ${verified.url} — ${verified.detail}`);
            }
        }
    }

    out.log.info(`Cursor Base URL: ${cursorUrl}`);
    scheduleBillingSyncForConfig(config);
    logger.info({ pid, localUrl, cursorUrl, exposure: config.public?.mode }, "ai-proxy up");

    return {
        started: true,
        pid,
        message: healthy ? "ai-proxy started" : "ai-proxy started (health pending)",
        localUrl,
        cursorUrl,
    };
}

export interface DownResult {
    stopped: boolean;
    pid?: number;
    message: string;
}

export async function runAiProxyDown(): Promise<DownResult> {
    const store = getAiProxyConfigStore();
    const config = await store.load();

    const runtime = await readRuntimeState();
    const targetPid = resolveLiveProxyPid() ?? runtime.proxy?.pid ?? null;

    if (targetPid === null || !isProcessAlive(targetPid)) {
        await clearRuntimeState();
        return { stopped: false, message: "ai-proxy is not running" };
    }

    try {
        process.kill(targetPid, "SIGTERM");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { stopped: false, pid: targetPid, message: `Failed to stop pid ${targetPid}: ${message}` };
    }

    await Bun.sleep(500);

    if (isProcessAlive(targetPid)) {
        try {
            process.kill(targetPid, "SIGKILL");
        } catch (err) {
            logger.warn({ err, pid: targetPid }, "ai-proxy down: SIGKILL failed");
        }
    }

    if (isProcessAlive(targetPid)) {
        return {
            stopped: false,
            pid: targetPid,
            message: `ai-proxy process ${targetPid} is still running after SIGKILL`,
        };
    }

    await clearRuntimeState();

    const tunnelNote =
        config.public?.mode === "cloudflared"
            ? " (cloudflared tunnel left running — dev-dashboard and other routes on the same hostname stay up)"
            : "";

    logger.info({ pid: targetPid }, "ai-proxy down");

    return {
        stopped: true,
        pid: targetPid,
        message: `Stopped ai-proxy (pid ${targetPid})${tunnelNote}`,
    };
}

export interface StatusResult {
    proxyRunning: boolean;
    proxyPid?: number;
    localHealth: boolean;
    publicHealth?: boolean;
    localUrl: string;
    cursorUrl?: string;
    publicUrl?: string;
    exposureMode: string;
    tunnelPid?: number;
    configPath: string;
    logPath: string;
}

export async function runAiProxyStatus(): Promise<StatusResult> {
    const store = getAiProxyConfigStore();
    const config = await store.load();
    const runtime = await readRuntimeState();
    const proxyPid = resolveLiveProxyPid() ?? runtime.proxy?.pid;
    const proxyRunning = proxyPid !== null && proxyPid !== undefined && isProcessAlive(proxyPid);

    const localHealthUrl = `http://${config.listen.host}:${config.listen.port}/health`;
    const localProbe = await probeUrl(localHealthUrl);
    const publicVerify = await verifyPublicExposure(config);

    return {
        proxyRunning,
        proxyPid: proxyRunning ? proxyPid : undefined,
        localHealth: localProbe.ok,
        publicHealth: publicVerify?.ok,
        localUrl: buildLocalBaseUrl(config),
        cursorUrl: resolveCursorBaseUrl(config),
        publicUrl: buildPublicBaseUrl(config) ?? undefined,
        exposureMode: config.public?.mode ?? "none",
        tunnelPid: runtime.tunnel?.pid,
        configPath: store.where(),
        logPath: getAiProxyStorage().proxyLogPath(),
    };
}

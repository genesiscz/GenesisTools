import { join } from "node:path";
import { getAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { ensurePublicExposure, verifyPublicExposure } from "@app/ai-proxy/lib/exposure";
import { buildLocalBaseUrl, buildPublicBaseUrl, resolveCursorBaseUrl } from "@app/ai-proxy/lib/public-url";
import {
    clearRuntimeState,
    inspectProxyPid,
    type ProxyPidState,
    readRuntimeState,
    writeProxyPid,
    writeRuntimeState,
} from "@app/ai-proxy/lib/runtime";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { probeUrl } from "@app/ai-proxy/lib/tunnel/cloudflared";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { scheduleBillingSyncForConfig } from "@app/ai-proxy/lib/usage/billing-sync";
import { spawnDetached } from "@genesiscz/utils/DashboardApp/detach";
import { waitForUrlReady } from "@genesiscz/utils/DashboardApp/readiness";
import { logger, out } from "@genesiscz/utils/logger";
import { getPortOwner } from "@genesiscz/utils/network";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

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

    const pidState = inspectProxyPid();

    if (pidState.status === "live" || pidState.status === "unverified") {
        return {
            started: false,
            pid: pidState.pid,
            message: `ai-proxy already running (pid ${pidState.pid})`,
            localUrl,
            cursorUrl,
        };
    }

    if (pidState.status === "dead" || pidState.status === "foreign") {
        const reason =
            pidState.status === "foreign"
                ? `pid ${pidState.pid} now belongs to another process (${pidState.command})`
                : `pid ${pidState.pid} is gone`;
        out.log.warn(`Clearing stale ai-proxy state — ${reason}`);
        logger.warn({ pidState }, "ai-proxy up: clearing stale runtime state");
        await clearRuntimeState();
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

    const pidState = inspectProxyPid();

    if (pidState.status === "foreign") {
        // Never signal a pid we can't prove is ours — a recycled pid can be any
        // program on the machine.
        logger.warn({ pidState }, "ai-proxy down: refusing to signal a recycled pid");
        await clearRuntimeState();

        return {
            stopped: false,
            pid: pidState.pid,
            message:
                `ai-proxy is not running — recorded pid ${pidState.pid} belongs to another process ` +
                `(${pidState.command}). Left it alone and cleared the stale record.`,
        };
    }

    if (pidState.status === "none" || pidState.status === "dead") {
        await clearRuntimeState();
        return { stopped: false, message: "ai-proxy is not running" };
    }

    if (pidState.status === "unverified") {
        // Alive, but `ps` could not tell us WHAT it is. Signalling on that basis is the
        // same bet as signalling a `foreign` pid — if the recorded pid was recycled, we
        // kill a stranger. The record is left alone: it may well still be our proxy.
        logger.warn({ pidState }, "ai-proxy down: refusing to signal a pid whose identity is unverifiable");

        return {
            stopped: false,
            pid: pidState.pid,
            message:
                `Refusing to stop pid ${pidState.pid}: it is running but could not be identified ` +
                `(reading its command line failed). Check it yourself with \`ps -p ${pidState.pid} -o command=\` ` +
                `and, if it is the proxy, stop it with \`kill ${pidState.pid}\`.`,
        };
    }

    const targetPid = pidState.pid;

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
    /** Full classification of the recorded pid — see {@link ProxyPidState}. */
    pidState: ProxyPidState;
    /** Set when the recorded pid is dead or recycled; names the repair command. */
    staleWarning?: string;
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
    const pidState = inspectProxyPid();
    const proxyRunning = pidState.status === "live" || pidState.status === "unverified";

    const localHealthUrl = `http://${config.listen.host}:${config.listen.port}/health`;
    const localProbe = await probeUrl(localHealthUrl);
    const publicVerify = await verifyPublicExposure(config);

    let staleWarning: string | undefined;
    if (pidState.status === "foreign") {
        staleWarning =
            `recorded pid ${pidState.pid} belongs to another process (${pidState.command}) — ` +
            `stale record, run \`tools ai-proxy up\` to restart`;
    } else if (pidState.status === "dead") {
        staleWarning = `recorded pid ${pidState.pid} is gone — run \`tools ai-proxy up\` to restart`;
    } else if (pidState.status === "live" && !localProbe.ok) {
        staleWarning = `pid ${pidState.pid} is alive but not answering ${localHealthUrl} — check ${getAiProxyStorage().proxyLogPath()}`;
    }

    return {
        proxyRunning,
        proxyPid: proxyRunning ? pidState.pid : undefined,
        pidState,
        staleWarning,
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

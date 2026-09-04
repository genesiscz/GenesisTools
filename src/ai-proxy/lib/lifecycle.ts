import { getAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { ensurePublicExposure, verifyPublicExposure } from "@app/ai-proxy/lib/exposure";
import {
    AI_PROXY_LAUNCHD_LABEL,
    aiProxyPlistPath,
    installAiProxyLaunchd,
    isAiProxyLaunchdInstalled,
    proxyEntryPath,
    startAiProxyLaunchd,
    stopAiProxyLaunchd,
    toolsRoot,
    uninstallAiProxyLaunchd,
} from "@app/ai-proxy/lib/launchd";
import { buildLocalBaseUrl, buildPublicBaseUrl, resolveCursorBaseUrl } from "@app/ai-proxy/lib/public-url";
import {
    clearRuntimeState,
    inspectProxyPid,
    isAiProxyServeCommand,
    type ProxyPidState,
    readProxyPid,
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
        // A launchd respawn writes its own pid file, so between the crash and the
        // restart the recorded pid can be stale while the port is already ours
        // again. Identify the owner rather than calling every listener a stranger.
        const ours = isAiProxyServeCommand(portOwner.command);

        return {
            started: false,
            pid: portOwner.pid,
            message: ours
                ? `ai-proxy already running (pid ${portOwner.pid})`
                : `Port ${config.listen.port} already in use by pid ${portOwner.pid} — not ai-proxy managed`,
            localUrl,
            cursorUrl,
        };
    }

    const launchdManaged = isAiProxyLaunchdInstalled();
    let pid: number | undefined;

    if (launchdManaged) {
        // The agent owns the process. Spawning our own would put a second proxy
        // on the port, and launchd would keep restarting the one we then killed.
        out.log.step(`Starting launchd agent ${AI_PROXY_LAUNCHD_LABEL}…`);
        await startAiProxyLaunchd();
    } else {
        pid = await spawnProxy(config);
    }

    const healthy = await waitForLocalHealth(config);

    if (launchdManaged) {
        pid = readProxyPid() ?? undefined;
    }

    const managedNote = launchdManaged ? " · launchd" : "";

    if (!healthy) {
        out.log.warn(
            `Local health check failed — proxy may still be starting. Logs: ${getAiProxyStorage().proxyLogPath()}`
        );
    } else {
        out.log.success(`ai-proxy listening on ${localUrl}${pid ? ` (pid ${pid})` : ""}${managedNote}`);
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
    logger.info({ pid, localUrl, cursorUrl, exposure: config.public?.mode, launchdManaged }, "ai-proxy up");

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

    // The tunnel is shared with dev-dashboard and every other route on the same
    // hostname. `down` stops the proxy and nothing else, on both paths.
    const tunnelNote =
        config.public?.mode === "cloudflared"
            ? " (cloudflared tunnel left running — dev-dashboard and other routes on the same hostname stay up)"
            : "";

    const launchdManaged = isAiProxyLaunchdInstalled();
    let bootedOut = false;

    if (launchdManaged) {
        // Bootout BEFORE any signal: with KeepAlive true, launchd answers a
        // SIGTERM by restarting the proxy a couple of seconds later, so killing
        // first would look like it worked and then silently undo itself.
        out.log.step(`Unloading launchd agent ${AI_PROXY_LAUNCHD_LABEL}…`);
        await stopAiProxyLaunchd();
        bootedOut = true;
        await Bun.sleep(500);
    }

    const launchdNote = bootedOut ? ` (launchd agent ${AI_PROXY_LAUNCHD_LABEL} unloaded)` : "";
    const pidState = inspectProxyPid();

    if (pidState.status === "foreign") {
        // Never signal a pid we can't prove is ours — a recycled pid can be any
        // program on the machine.
        logger.warn({ pidState }, "ai-proxy down: refusing to signal a recycled pid");
        await clearRuntimeState();

        return {
            // The bootout above IS the stop on the launchd path; the recorded pid
            // provably belongs to something else, so there is nothing left to kill.
            stopped: bootedOut,
            pid: pidState.pid,
            message:
                `ai-proxy is not running${launchdNote} — recorded pid ${pidState.pid} belongs to another process ` +
                `(${pidState.command}). Left it alone and cleared the stale record.`,
        };
    }

    if (pidState.status === "none" || pidState.status === "dead") {
        await clearRuntimeState();

        // The bootout above is what stopped it — reporting "not running" here
        // would hide the fact that `down` did the work.
        if (bootedOut) {
            return { stopped: true, message: `Stopped ai-proxy${launchdNote}${tunnelNote}` };
        }

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
                `Refusing to stop pid ${pidState.pid}${launchdNote}: it is running but could not be identified ` +
                `(reading its command line failed). Check it yourself with \`ps -p ${pidState.pid} -o command=\` ` +
                `and, if it is the proxy, stop it with \`kill ${pidState.pid}\`.`,
        };
    }

    const targetPid = pidState.pid;

    try {
        // pid-verified: inspectProxyPid classified this pid live; foreign and unverified were refused earlier
        process.kill(targetPid, "SIGTERM");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { stopped: false, pid: targetPid, message: `Failed to stop pid ${targetPid}: ${message}` };
    }

    await Bun.sleep(500);

    if (isProcessAlive(targetPid)) {
        // pid-verified: escalation on the pid inspectProxyPid already confirmed
        try {
            // pid-verified: escalation on the pid inspectProxyPid already confirmed
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

    logger.info({ pid: targetPid, bootedOut }, "ai-proxy down");

    return {
        stopped: true,
        pid: targetPid,
        message: `Stopped ai-proxy (pid ${targetPid})${launchdNote}${tunnelNote}`,
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
    /** True when a launchd agent owns the proxy (survives reboot, respawns on crash). */
    launchdInstalled: boolean;
    launchdLabel: string;
    plistPath: string;
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
        launchdInstalled: isAiProxyLaunchdInstalled(),
        launchdLabel: AI_PROXY_LAUNCHD_LABEL,
        plistPath: aiProxyPlistPath(),
    };
}

export interface LaunchdInstallResult {
    installed: boolean;
    label: string;
    plistPath: string;
    port: number;
    healthy: boolean;
    message: string;
}

/**
 * Install the launchd agent so the proxy survives reboot and respawns on crash.
 *
 * This is the fix for the 2026-08-31 outage: the proxy had been down for ten
 * days, and the only symptom was `ECONNREFUSED 127.0.0.1:8317` inside two MCP
 * servers whose plain API tools kept working.
 */
export async function runAiProxyInstallLaunchd(): Promise<LaunchdInstallResult> {
    if (process.platform !== "darwin") {
        throw new Error("Launchd integration is macOS-only.");
    }

    const store = getAiProxyConfigStore();
    const config = await store.load();
    const port = config.listen.port;

    // A hand-spawned proxy already owns the port; the agent's first start would
    // die on EADDRINUSE and KeepAlive would then respawn it in a loop. The port
    // is asked, not the pid file: a cleared or stale record says nothing about
    // who holds the socket right now.
    if (!isAiProxyLaunchdInstalled()) {
        const owner = await getPortOwner(port);

        if (owner?.pid && isProcessAlive(owner.pid)) {
            if (!isAiProxyServeCommand(owner.command)) {
                throw new Error(
                    `Port ${port} is held by pid ${owner.pid} (${owner.command}), which is not ai-proxy. ` +
                        "Stop it or change listen.port before installing the launchd agent."
                );
            }

            out.log.step(`Stopping the manually started proxy (pid ${owner.pid}) first…`);
            const stopped = await runAiProxyDown();

            if (!stopped.stopped && isProcessAlive(owner.pid)) {
                // `down` works from the pid file, so with that record gone it had
                // nothing to signal while the proxy still holds the port.
                // pid-verified: owner.pid is a live lsof result whose command matched isAiProxyServeCommand just above
                process.kill(owner.pid, "SIGTERM");
            }

            const deadline = Date.now() + 3000;
            while (isProcessAlive(owner.pid) && Date.now() < deadline) {
                await Bun.sleep(100);
            }

            // Installing over a proxy that ignored SIGTERM would start the very
            // EADDRINUSE respawn loop this block exists to prevent.
            if (isProcessAlive(owner.pid)) {
                throw new Error(
                    `The manually started proxy (pid ${owner.pid}) still holds port ${port} after SIGTERM. ` +
                        "Stop it yourself, then install the launchd agent."
                );
            }
        }
    }

    await installAiProxyLaunchd(port);
    const healthy = await waitForLocalHealth(config);

    logger.info({ label: AI_PROXY_LAUNCHD_LABEL, port, healthy }, "ai-proxy launchd installed");

    return {
        installed: true,
        label: AI_PROXY_LAUNCHD_LABEL,
        plistPath: aiProxyPlistPath(),
        port,
        healthy,
        message: healthy
            ? `Launchd agent ${AI_PROXY_LAUNCHD_LABEL} installed and answering on ${buildLocalBaseUrl(config)}`
            : `Launchd agent ${AI_PROXY_LAUNCHD_LABEL} installed but not answering yet — check ${getAiProxyStorage().proxyLogPath()}`,
    };
}

export interface LaunchdUninstallResult {
    removed: boolean;
    label: string;
    plistPath: string;
    message: string;
}

export async function runAiProxyUninstallLaunchd(): Promise<LaunchdUninstallResult> {
    const plistPath = aiProxyPlistPath();

    if (!isAiProxyLaunchdInstalled()) {
        return {
            removed: false,
            label: AI_PROXY_LAUNCHD_LABEL,
            plistPath,
            message: `No launchd agent installed (${plistPath} does not exist)`,
        };
    }

    await uninstallAiProxyLaunchd();
    await clearRuntimeState();

    logger.info({ label: AI_PROXY_LAUNCHD_LABEL }, "ai-proxy launchd uninstalled");

    return {
        removed: true,
        label: AI_PROXY_LAUNCHD_LABEL,
        plistPath,
        message: `Launchd agent ${AI_PROXY_LAUNCHD_LABEL} unloaded and ${plistPath} removed — start the proxy again with \`tools ai-proxy up\``,
    };
}

import type { ExposureEnsureResult, ExposureVerifyResult } from "@app/ai-proxy/lib/exposure/types";
import { verifyPublicHealthProbe } from "@app/ai-proxy/lib/exposure/verify-health";
import { resolveTunnelName } from "@app/ai-proxy/lib/public-url";
import { readRuntimeState, writeRuntimeState } from "@app/ai-proxy/lib/runtime";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { isTunnelProcessRunning } from "@app/ai-proxy/lib/tunnel/cloudflared";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { spawnDetached } from "@app/utils/DashboardApp/detach";
import { isProcessAlive } from "@app/utils/process-alive";

export async function ensureCloudflaredExposure(config: AiProxyConfig): Promise<ExposureEnsureResult> {
    const tunnelName = resolveTunnelName(config.public);

    if (!tunnelName) {
        return {
            started: false,
            message:
                "cloudflared mode requires public.cloudflared.tunnelName — run: tools ai-proxy config setup-tunnel",
        };
    }

    if (config.public?.cloudflared?.autoStart === false) {
        return {
            started: false,
            message: "cloudflared autoStart disabled — start tunnel manually if needed",
        };
    }

    if (isTunnelProcessRunning(tunnelName)) {
        return {
            started: false,
            alreadyRunning: true,
            message: `Tunnel '${tunnelName}' already running (shared hostname — dev-dashboard and other routes stay up)`,
        };
    }

    const storage = getAiProxyStorage();
    const logFile = storage.tunnelLogPath();

    try {
        const { pid } = spawnDetached({
            cmd: ["cloudflared", "tunnel", "run", tunnelName],
            logFile,
        });

        if (!isProcessAlive(pid)) {
            return {
                started: false,
                message: `Failed to start tunnel '${tunnelName}' — see ${logFile}`,
            };
        }

        try {
            const runtime = await readRuntimeState();
            runtime.tunnel = {
                pid,
                provider: "cloudflared",
                startedAt: new Date().toISOString(),
                tunnelName,
            };
            await writeRuntimeState(runtime);
        } catch (err) {
            logger.warn({ err, pid, tunnelName }, "ai-proxy: tunnel started but runtime state write failed");
            return {
                started: true,
                pid,
                message: `Started tunnel '${tunnelName}' (pid ${pid}) but failed to persist runtime state — see ${logFile}`,
            };
        }

        return {
            started: true,
            pid,
            message: `Started tunnel '${tunnelName}' (pid ${pid}) — shared hostname; ai-proxy down will NOT stop it`,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, tunnelName, logFile }, "ai-proxy: cloudflared spawn failed");

        return {
            started: false,
            message: `Failed to start tunnel '${tunnelName}': ${message}`,
        };
    }
}

export async function verifyCloudflaredExposure(config: AiProxyConfig): Promise<ExposureVerifyResult> {
    return verifyPublicHealthProbe(config, "missing hostname/basePath in public config");
}

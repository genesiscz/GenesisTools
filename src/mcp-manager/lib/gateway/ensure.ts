import { readUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { logger } from "@genesiscz/utils/logger";
import { gatewayBaseUrl, gatewayListen } from "../auth/project.ts";
import { type GatewayHandle, startGatewayServer } from "./server.ts";

const started: GatewayHandle[] = [];

/**
 * In-flight ensureGatewayUp per host:port. Two concurrent callers both read `down`,
 * both call startGatewayServer on the same port, and the loser throws EADDRINUSE —
 * which surfaces as an unrelated startup failure rather than as a race.
 */
const starting = new Map<string, Promise<void>>();

/** A probe that never returns is worse than one that says "down": every caller of
 * ensureGatewayUp blocks behind it, including createKit and `tools scripts doctor`.
 * A stranger holding the port can accept the connection and then say nothing. */
const HEALTH_TIMEOUT_MS = 1500;

export async function gatewayHealth(host: string, port: number): Promise<"ok" | "stranger" | "down"> {
    try {
        const response = await fetch(`${gatewayBaseUrl({ host, port })}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });

        if (!response.ok) {
            return "stranger";
        }

        const json = (await response.json()) as { service?: string };

        return json.service === "mcp-gateway" ? "ok" : "stranger";
    } catch {
        return "down";
    }
}

export async function ensureGatewayUp(config: UnifiedMCPConfig): Promise<void> {
    const listen = gatewayListen(config);
    const key = `${listen.host}:${listen.port}`;
    const inFlight = starting.get(key);

    if (inFlight) {
        return inFlight;
    }

    const attempt = startOnce(config, listen).finally(() => {
        starting.delete(key);
    });
    starting.set(key, attempt);

    return attempt;
}

async function startOnce(config: UnifiedMCPConfig, listen: { host: string; port: number }): Promise<void> {
    const health = await gatewayHealth(listen.host, listen.port);

    if (health === "ok") {
        return;
    }

    if (health === "stranger") {
        throw new Error(`port ${listen.port} is in use by another process. Run tools mcp-manager gateway status`);
    }

    const handle = await startGatewayServer(config, {
        hostname: listen.host,
        port: listen.port,
        readConfig: readUnifiedConfig,
    });
    // Every caller of ensureGatewayUp wants a gateway to EXIST, not to be kept alive
    // by it: `auth login` printed "logged in" and then hung forever, and `tools
    // scripts run` inherited the same hang through kit.ts. Unref-ing here fixes both
    // at the lifecycle rather than at each caller, and cannot regress `gateway start`,
    // which builds its handle through startGatewayServer directly and needs the ref.
    started.push(handle);
    handle.unref();
    logger.info({ port: handle.port }, "mcp gateway started in-process");
}

/** Returns how many listeners this process actually stopped, which may be zero. */
export function stopInProcessGateways(): number {
    const handles = started.splice(0);

    for (const handle of handles) {
        handle.stop();
    }

    return handles.length;
}

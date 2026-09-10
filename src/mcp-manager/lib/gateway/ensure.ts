import type { UnifiedMCPConfig } from "@app/mcp-manager/utils/providers/types.js";
import { logger } from "@genesiscz/utils/logger";
import { gatewayListen } from "../auth/project.ts";
import { startGatewayServer } from "./server.ts";

const started: { stop: () => void; port: number }[] = [];

export async function gatewayHealth(host: string, port: number): Promise<"ok" | "stranger" | "down"> {
    try {
        const response = await fetch(`http://${host}:${port}/health`);

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
    const health = await gatewayHealth(listen.host, listen.port);

    if (health === "ok") {
        return;
    }

    if (health === "stranger") {
        throw new Error(`port ${listen.port} is in use by another process. Run tools mcp-manager gateway status`);
    }

    const handle = await startGatewayServer(config, { hostname: listen.host, port: listen.port });
    started.push(handle);
    logger.info({ port: handle.port }, "mcp gateway started in-process");
}

export function stopInProcessGateways(): void {
    for (const handle of started.splice(0)) {
        handle.stop();
    }
}

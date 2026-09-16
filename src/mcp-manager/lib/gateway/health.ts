import { logger } from "@genesiscz/utils/logger";
import { gatewayBaseUrl } from "../auth/project.ts";

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

        try {
            const json: unknown = await response.json();
            const service = json && typeof json === "object" && "service" in json ? json.service : undefined;

            return service === "mcp-gateway" ? "ok" : "stranger";
        } catch (error) {
            logger.debug({ host, port, error }, "mcp gateway /health answered but was not our JSON");

            return "stranger";
        }
    } catch (error) {
        logger.debug({ host, port, error }, "mcp gateway /health probe failed");

        return "down";
    }
}

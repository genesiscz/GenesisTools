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

        const json = (await response.json()) as { service?: string };

        return json.service === "mcp-gateway" ? "ok" : "stranger";
    } catch {
        return "down";
    }
}

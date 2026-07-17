import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

/**
 * Parses a JSON object body; `null` for missing/non-JSON/non-object bodies.
 * Strict parse — request bodies are machine-produced, comments are not welcome.
 */
export async function safeJsonBody(req: Request): Promise<Record<string, unknown> | null> {
    const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();

    if (contentType !== "application/json") {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(await req.text(), { strict: true });

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch (error) {
        logger.debug({ error, path: new URL(req.url).pathname }, "youtube server: invalid JSON body");
    }

    return null;
}

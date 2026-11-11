import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Opt-in (AI_PROXY_DEBUG_CAPTURE=1) dump of the last failing upstream exchange.
 * The capture carries the upstream request BODY and response text, unredacted. It
 * leaves out the headers (the Authorization token, the proxy API key), but a secret
 * inside the body (a pasted key, a tool result, an echoed error) is written as is.
 */
export function captureUpstreamFailure(input: {
    provider: string;
    account: string;
    model: string;
    status: number;
    requestBody: string;
    responseBody: string;
}): void {
    if (!env.aiProxy.getDebugCapture()) {
        return;
    }

    const path = join(getAiProxyStorage().getBaseDir(), "debug", `last-${input.provider}-failure.json`);
    const capture = {
        ts: new Date().toISOString(),
        ...input,
    };

    void Bun.write(path, `${SafeJSON.stringify(capture, null, 2)}\n`)
        .then(() => {
            logger.info({ path, status: input.status }, "ai-proxy: captured failing upstream exchange");
        })
        .catch((err) => {
            logger.debug({ err, path }, "ai-proxy: debug capture write failed");
        });
}

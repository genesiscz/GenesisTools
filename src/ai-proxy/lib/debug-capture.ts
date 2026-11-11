import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

/**
 * Opt-in (AI_PROXY_DEBUG_CAPTURE=1) dump of the last failing upstream exchange.
 * The capture carries the upstream request BODY and response text, unredacted. It
 * leaves out the headers (the Authorization token, the proxy API key), but a secret
 * inside the body (a pasted key, a tool result, an echoed error) is written as is,
 * so the file is 0600 in a 0700 folder, as the transcripts are.
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

    const dir = join(getAiProxyStorage().getBaseDir(), "debug");
    const path = join(dir, `last-${input.provider}-failure.json`);
    const capture = {
        ts: new Date().toISOString(),
        ...input,
    };

    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // A folder an older proxy created 0755 is tightened too.
        chmodSync(dir, 0o700);
        atomicWriteFileSync(path, `${SafeJSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
        logger.info({ path, status: input.status }, "ai-proxy: captured failing upstream exchange");
    } catch (err) {
        logger.debug({ err, path }, "ai-proxy: debug capture write failed");
    }
}

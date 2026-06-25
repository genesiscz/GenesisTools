import { existsSync, readFileSync } from "node:fs";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { grokVersionPath } from "./paths";

const DEFAULT_GROK_CLIENT_VERSION = "0.2.60";

export function readGrokClientVersion(homePath?: string): string {
    const versionPath = grokVersionPath(homePath);

    if (!existsSync(versionPath)) {
        return DEFAULT_GROK_CLIENT_VERSION;
    }

    try {
        const raw = SafeJSON.parse(readFileSync(versionPath, "utf-8")) as { version?: string };
        if (typeof raw.version === "string" && raw.version.length > 0) {
            return raw.version;
        }
    } catch (err) {
        logger.debug({ err, versionPath }, "grok: failed to read client version file");
        return DEFAULT_GROK_CLIENT_VERSION;
    }

    return DEFAULT_GROK_CLIENT_VERSION;
}

export function buildCliProxyHeaders({
    token,
    modelOverride,
    clientVersion,
}: {
    token: string;
    modelOverride?: string;
    clientVersion?: string;
}): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-client-version": clientVersion ?? readGrokClientVersion(),
        "Content-Type": "application/json",
    };

    if (modelOverride) {
        headers["x-grok-model-override"] = modelOverride;
    }

    return headers;
}

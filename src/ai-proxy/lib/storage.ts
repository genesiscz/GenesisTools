import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";

const TOOL_NAME = "ai-proxy";

/**
 * Owner-only: this config carries the proxy bearer key and, since
 * `accounts[].apiKey`, billed vendor credentials in plain text. Declared on the
 * storage instance so every writer of config.json honours it, not just the one
 * `AiProxyConfigStore.save` happens to call.
 */
export const AI_PROXY_CONFIG_FILE_MODE = 0o600;

export class AiProxyStorage extends Storage {
    constructor() {
        super(TOOL_NAME, { configFileMode: AI_PROXY_CONFIG_FILE_MODE });
    }

    runtimePath(): string {
        return join(this.getBaseDir(), "runtime.json");
    }

    proxyPidPath(): string {
        return join(this.getBaseDir(), "proxy.pid");
    }

    proxyLogPath(): string {
        return join(this.getBaseDir(), "proxy.log");
    }

    tunnelLogPath(): string {
        return join(this.getBaseDir(), "tunnel.log");
    }

    /** Per-account probe results. Never committed — see catalog-file.ts. */
    modelsCatalogPath(): string {
        return join(this.getBaseDir(), "models-catalog.json");
    }
}

let _instance: AiProxyStorage | null = null;

export function getAiProxyStorage(): AiProxyStorage {
    if (!_instance) {
        _instance = new AiProxyStorage();
    }

    return _instance;
}

export function resetAiProxyStorage(): void {
    _instance = null;
}

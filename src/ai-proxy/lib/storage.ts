import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";

const TOOL_NAME = "ai-proxy";

export class AiProxyStorage extends Storage {
    constructor() {
        super(TOOL_NAME);
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

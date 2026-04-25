import { Storage } from "@app/utils/storage";

export type DeviceRole = "server" | "client" | "both";

export interface RegisteredClient {
    name: string;
    password: string;
    mac: string;
    broadcast: string;
    wolPort: number;
}

export interface ServerSettings {
    host?: string;
    port?: number;
    token?: string;
    broadcast?: string;
    wolPort?: number;
    defaultMac?: string;
    clients?: RegisteredClient[];
    logRequests?: boolean;
}

export interface ClientSettings {
    name?: string;
    password?: string;
    mac?: string;
    broadcast?: string;
    wolPort?: number;
    serverHost?: string;
    serverPort?: number;
}

export interface WakeupConfig {
    role?: DeviceRole;
    server?: ServerSettings;
    client?: ClientSettings;
}

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_WOL_PORT = 9;

export function createWakeupStorage(): Storage {
    return new Storage("wakeup");
}

export async function readWakeupConfig(storage: Storage): Promise<WakeupConfig> {
    const config = await storage.getConfig<WakeupConfig>();

    if (!config) {
        return {};
    }

    return config;
}

export async function writeWakeupConfig(storage: Storage, config: WakeupConfig): Promise<void> {
    await storage.setConfig(config);
}

export async function updateWakeupConfig(
    storage: Storage,
    updater: (current: WakeupConfig) => WakeupConfig
): Promise<WakeupConfig> {
    return storage.withConfigLock(async () => {
        const current = (await storage.getConfig<WakeupConfig>()) ?? {};
        const next = updater(current);
        await storage.setConfig(next);
        return next;
    });
}

export function parseServerInput(
    input: string,
    defaultPort: number = DEFAULT_HTTP_PORT
): {
    host: string;
    port: number;
} {
    const trimmed = input.trim();

    if (!trimmed.includes(":")) {
        return { host: trimmed, port: defaultPort };
    }

    const [rawHost, rawPort] = trimmed.split(":");
    const host = rawHost || "localhost";
    const port = Number.parseInt(rawPort || String(defaultPort), 10);

    if (Number.isNaN(port) || port <= 0 || port > 65535) {
        return { host, port: defaultPort };
    }

    return { host, port };
}

export function formatServerAddress(host: string, port: number): string {
    if (host.startsWith("http://") || host.startsWith("https://")) {
        return `${host.replace(/\/+$/, "")}:${port}`;
    }

    return `${host}:${port}`;
}

export function mergeRole(current: DeviceRole | undefined, desired: DeviceRole): DeviceRole {
    if (!current) {
        return desired;
    }

    if (current === desired) {
        return current;
    }

    return "both";
}

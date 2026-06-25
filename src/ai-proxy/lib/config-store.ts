import { migrateAccountConfig } from "@app/ai-proxy/lib/account-config";
import { normalizeBasePath } from "@app/ai-proxy/lib/path-prefix";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyConfig, AiProxyPublicConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@app/utils/json";

export function getDefaultConfig(): AiProxyConfig {
    return {
        listen: { host: "127.0.0.1", port: 8317 },
        proxyApiKey: `aipx-${crypto.randomUUID().replace(/-/g, "")}`,
        translation: { cursorAgent: "auto", thinking: "raw" },
        public: { mode: "none", basePath: "/ai" },
        accounts: [],
    };
}

function migratePublicConfig(raw?: AiProxyPublicConfig): AiProxyPublicConfig | undefined {
    if (!raw) {
        return { mode: "none", basePath: "/ai" };
    }

    const next: AiProxyPublicConfig = { ...raw };

    if (!next.mode) {
        if (next.baseUrl) {
            next.mode = "custom";
        } else if (next.hostname && (next.tunnelName || next.cloudflared?.tunnelName)) {
            next.mode = "cloudflared";
        } else if (next.hostname && next.tailscale?.hostname) {
            next.mode = "tailscale";
        } else if (next.hostname) {
            next.mode = "custom";
        } else {
            next.mode = "none";
        }
    }

    if (!next.cloudflared) {
        next.cloudflared = {};
    }

    if (raw.tunnelName && !next.cloudflared.tunnelName) {
        next.cloudflared.tunnelName = raw.tunnelName;
    }

    if (raw.cloudflaredConfigPath && !next.cloudflared.configPath) {
        next.cloudflared.configPath = raw.cloudflaredConfigPath;
    }

    if (next.cloudflared.autoStart === undefined && next.mode === "cloudflared") {
        next.cloudflared.autoStart = true;
    }

    if (!next.basePath) {
        next.basePath = "/ai";
    } else {
        next.basePath = normalizeBasePath(next.basePath) || "/ai";
    }

    delete next.tunnelName;
    delete next.cloudflaredConfigPath;

    return next;
}

function mergeConfig(existing: Partial<AiProxyConfig>): AiProxyConfig {
    const defaults = getDefaultConfig();

    return {
        ...defaults,
        ...existing,
        listen: { ...defaults.listen, ...existing.listen },
        translation: {
            ...defaults.translation,
            ...existing.translation,
            thinking: existing.translation?.thinking ?? defaults.translation.thinking,
        },
        public: migratePublicConfig(existing.public),
        accounts: (existing.accounts ?? []).map((account) => migrateAccountConfig(account)),
    };
}

export class AiProxyConfigStore {
    private readonly storage = getAiProxyStorage();
    private cached: AiProxyConfig | null = null;

    where(): string {
        return this.storage.getConfigPath();
    }

    async load(): Promise<AiProxyConfig> {
        if (this.cached) {
            return structuredClone(this.cached);
        }

        const config = await this.readFromDisk();
        this.cached = config;

        return structuredClone(config);
    }

    /** Always reads config.json — use in long-running serve process for hot reload. */
    async loadFresh(): Promise<AiProxyConfig> {
        return structuredClone(await this.readFromDisk());
    }

    private async readFromDisk(): Promise<AiProxyConfig> {
        const existing = await this.storage.getConfig<Partial<AiProxyConfig>>();
        return existing ? mergeConfig(existing) : getDefaultConfig();
    }

    async save(config: AiProxyConfig): Promise<void> {
        const normalized = mergeConfig(config);
        await this.storage.ensureDirs();
        await this.storage.setConfig(normalized);
        this.cached = normalized;
    }

    async update(patch: Partial<AiProxyConfig>): Promise<AiProxyConfig> {
        const current = await this.load();
        const next = mergeConfig({
            ...current,
            ...patch,
            listen: { ...current.listen, ...patch.listen },
            translation: { ...current.translation, ...patch.translation },
            public:
                patch.public !== undefined
                    ? {
                          ...current.public,
                          ...patch.public,
                          cloudflared: { ...current.public?.cloudflared, ...patch.public?.cloudflared },
                          tailscale: { ...current.public?.tailscale, ...patch.public?.tailscale },
                      }
                    : current.public,
            accounts: patch.accounts ?? current.accounts,
        });
        await this.save(next);
        return next;
    }
}

let _store: AiProxyConfigStore | null = null;

export function getAiProxyConfigStore(): AiProxyConfigStore {
    if (!_store) {
        _store = new AiProxyConfigStore();
    }

    return _store;
}

export function resetAiProxyConfigStore(): void {
    _store = null;
}

export function redactConfig(config: AiProxyConfig): AiProxyConfig {
    return {
        ...config,
        proxyApiKey: config.proxyApiKey ? `${config.proxyApiKey.slice(0, 8)}…` : "",
    };
}

export function parseConfigJson(text: string): AiProxyConfig {
    const parsed = SafeJSON.parse(text) as Partial<AiProxyConfig>;
    return mergeConfig(parsed);
}

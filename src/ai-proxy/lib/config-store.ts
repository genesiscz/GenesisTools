import { chmod, stat } from "node:fs/promises";
import { migrateAccountConfig } from "@app/ai-proxy/lib/account-config";
import { normalizeBasePath } from "@app/ai-proxy/lib/path-prefix";
import { maskApiKey } from "@app/ai-proxy/lib/providers/api-key-state";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyConfig, AiProxyPublicConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";

/** Owner-only: the config carries the proxy bearer key and billed vendor keys. */
const CONFIG_FILE_MODE = 0o600;

/**
 * Whether any group or other bit survived on the config's mode. Split out so the
 * mask itself is pinned by tests: narrowing it to `0o007` would stop catching a
 * group-readable file, and comparing against `0o600` instead would report a
 * stricter 0o400 as a problem. Both are silent failures of a security check.
 */
export function isReadableByOthers(mode: number): boolean {
    return (mode & 0o077) !== 0;
}

/**
 * The filesystem calls the permission check makes, injectable so both failure
 * shapes can be driven from a test without mocking `node:fs` process-wide.
 */
export interface ConfigPermissionOps {
    chmod: (path: string, mode: number) => Promise<void>;
    statMode: (path: string) => Promise<number>;
}

const realPermissionOps: ConfigPermissionOps = {
    chmod: (path, mode) => chmod(path, mode),
    statMode: async (path) => (await stat(path)).mode & 0o777,
};

/**
 * Enforce owner-only on the config and report what actually stuck: the octal
 * mode when the file is still reachable by somebody else, `"unknown"` when the
 * filesystem refused to answer, and undefined when it is owner-only.
 *
 * It reports the RESULTING mode rather than the requested one on purpose — the
 * whole point is to catch a chmod that claimed success without doing anything.
 */
export async function checkConfigPermissions(
    path: string,
    ops: ConfigPermissionOps = realPermissionOps
): Promise<string | undefined> {
    try {
        await ops.chmod(path, CONFIG_FILE_MODE);
        const mode = await ops.statMode(path);

        return isReadableByOthers(mode) ? mode.toString(8) : undefined;
    } catch (err) {
        logger.warn({ err, path }, "ai-proxy: could not restrict config file permissions to owner-only");

        return "unknown";
    }
}

export function getDefaultConfig(): AiProxyConfig {
    return {
        listen: { host: "127.0.0.1", port: 8317 },
        proxyApiKey: `aipx-${crypto.randomUUID().replace(/-/g, "")}`,
        translation: { cursorAgent: "auto", thinking: "cursor" },
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
        // The mode travels with the temp file through the rename, so the key is
        // never published at the umask default even for an instant.
        await this.storage.setConfig(normalized, { mode: CONFIG_FILE_MODE });
        await this.restrictConfigPermissions();
        this.cached = normalized;
    }

    /**
     * Defence in depth behind `save`'s birth-mode: that closes the disclosure
     * window, this catches the case where the mode never took effect at all —
     * on a filesystem without POSIX permissions (exFAT, some network mounts)
     * every chmod succeeds and changes nothing. The file holds the proxy bearer
     * key and, since `accounts[].apiKey`, billed vendor credentials in plain
     * text, so a silent no-op there must not read as success.
     */
    private async restrictConfigPermissions(): Promise<void> {
        const path = this.storage.getConfigPath();
        const insecureMode = await checkConfigPermissions(path);

        if (insecureMode) {
            this.warnConfigReadable(path, insecureMode);
        }
    }

    /**
     * Deliberately does not throw. The config, key included, is already on disk
     * by the time this runs, so failing the save would report "nothing was
     * saved" about a file that now holds the credential. What the caller can
     * actually act on is the path and the command that fixes it.
     */
    private warnConfigReadable(path: string, mode: string): void {
        logger.warn(
            { path, mode, fix: `chmod 600 ${path}` },
            "ai-proxy: config file with billed api keys is readable by other local accounts"
        );
        out.log.warn(`${path} holds billed API keys and is readable by other local accounts. Fix: chmod 600 ${path}`);
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
    // `maskApiKey` rather than a prefix slice: a short key is entirely inside its
    // own first few characters, which is the one case redaction has to survive.
    return {
        ...config,
        proxyApiKey: config.proxyApiKey ? maskApiKey(config.proxyApiKey) : "",
        accounts: config.accounts.map((account) =>
            account.apiKey ? { ...account, apiKey: maskApiKey(account.apiKey) } : account
        ),
    };
}

export function parseConfigJson(text: string): AiProxyConfig {
    const parsed = SafeJSON.parse(text) as Partial<AiProxyConfig>;
    return mergeConfig(parsed);
}

import type {
    AIAccountEntry,
    AIConfigData,
    AIProvider,
    AIProviderType,
    AITask,
    AppConfig,
    AppDefaults,
    ProviderConfig,
    TaskConfig,
} from "@app/utils/config/ai.types";
import { Storage } from "@app/utils/storage/storage";

const DEFAULT_TASKS: Record<string, TaskConfig> = {
    transcribe: { provider: "local-hf" },
    translate: { provider: "local-hf" },
    summarize: { provider: "cloud" },
    classify: { provider: "darwinkit" },
    embed: { provider: "darwinkit" },
    sentiment: { provider: "darwinkit" },
};

/** Fill missing fields with sensible defaults on raw config from disk */
function applyDefaults(raw: Partial<AIConfigData> | null): AIConfigData {
    const tasks = { ...DEFAULT_TASKS };

    if (raw?.tasks) {
        for (const [key, value] of Object.entries(raw.tasks)) {
            tasks[key] = value;
        }
    }

    return {
        _schemaVersion: raw?._schemaVersion ?? 3,
        accounts: raw?.accounts ?? [],
        defaultAccounts: raw?.defaultAccounts ?? {},
        tasks,
        apps: raw?.apps ?? {},
        providers: raw?.providers ?? {},
    };
}

export class AIConfig {
    private static instance: AIConfig | null = null;
    private storage: Storage;
    private data: AIConfigData;

    private constructor(storage: Storage, data: AIConfigData) {
        this.storage = storage;
        this.data = data;
    }

    // ── Lifecycle ──

    static async load(): Promise<AIConfig> {
        if (AIConfig.instance) {
            return AIConfig.instance;
        }

        const { runMigrations } = await import("@app/utils/config/migration");
        const { migrateAI } = await import("@app/utils/config/migrations/2026-04-07-migrateAI");
        await runMigrations([migrateAI]);

        const storage = new Storage("ai");
        const raw = await storage.getConfig<Partial<AIConfigData>>();
        const data = applyDefaults(raw);

        AIConfig.instance = new AIConfig(storage, data);
        return AIConfig.instance;
    }

    static invalidate(): void {
        AIConfig.instance = null;
    }

    // ── Task config ──

    getTask(task: AITask): TaskConfig {
        return this.data.tasks[task] ?? DEFAULT_TASKS[task];
    }

    async setTask(task: AITask, config: Partial<TaskConfig>): Promise<void> {
        const current = this.getTask(task);
        const merged = { ...current, ...config };

        await this.mutate((data) => {
            data.tasks[task] = merged;
        });
    }

    getTaskProvider(task: AITask): AIProviderType {
        return this.getTask(task).provider;
    }

    // ── Account CRUD ──

    getAccount(name: string): AIAccountEntry | undefined {
        return this.data.accounts.find((a) => a.name === name);
    }

    getAccountsByProvider(provider: AIProvider): AIAccountEntry[] {
        return this.data.accounts.filter((a) => a.provider === provider);
    }

    getAccountsByApp(app: string): AIAccountEntry[] {
        return this.data.accounts.filter((a) => a.apps?.includes(app));
    }

    /**
     * Add an account and set it as default for the given contexts if no default exists yet.
     * Combines addAccount + setDefaultAccount in a single atomic write.
     */
    async addAccountWithDefaults(entry: AIAccountEntry, contexts: string[] = ["claude", "ask"]): Promise<void> {
        await this.mutate((data) => {
            const existing = data.accounts.findIndex((a) => a.name === entry.name);

            if (existing >= 0) {
                data.accounts[existing] = entry;
            } else {
                data.accounts.push(entry);
            }

            for (const ctx of contexts) {
                if (!data.defaultAccounts[ctx]) {
                    data.defaultAccounts[ctx] = entry.name;
                }
            }
        });
    }

    async addAccount(entry: AIAccountEntry): Promise<void> {
        await this.mutate((data) => {
            const existing = data.accounts.findIndex((a) => a.name === entry.name);

            if (existing >= 0) {
                data.accounts[existing] = entry;
            } else {
                data.accounts.push(entry);
            }
        });
    }

    async removeAccount(name: string): Promise<void> {
        await this.mutate((data) => {
            data.accounts = data.accounts.filter((a) => a.name !== name);

            // Cascade: clear any defaultAccounts entries pointing to the removed account
            for (const [context, accountName] of Object.entries(data.defaultAccounts)) {
                if (accountName === name) {
                    delete data.defaultAccounts[context];
                }
            }
        });
    }

    async updateAccount(name: string, updates: Partial<AIAccountEntry>): Promise<void> {
        await this.mutate((data) => {
            const idx = data.accounts.findIndex((a) => a.name === name);

            if (idx < 0) {
                throw new Error(`Account "${name}" not found`);
            }

            data.accounts[idx] = { ...data.accounts[idx], ...updates };
        });
    }

    listAccounts(): AIAccountEntry[] {
        return [...this.data.accounts];
    }

    /**
     * Find the account used for a given provider type in a context.
     * Matches both "anthropic" and "anthropic-sub" variants.
     * Prefers the context default, falls back to first matching account.
     */
    getAccountForProvider(providerName: string, context = "ask"): AIAccountEntry | undefined {
        const matches = this.data.accounts.filter(
            (a) => a.provider === providerName || a.provider === `${providerName}-sub`,
        );

        if (matches.length === 0) {
            return undefined;
        }

        const defaultName = this.data.defaultAccounts[context];

        if (defaultName) {
            const defaultMatch = matches.find((a) => a.name === defaultName);

            if (defaultMatch) {
                return defaultMatch;
            }
        }

        return matches[0];
    }

    // ── Default accounts (per-context) ──

    getDefaultAccount(context: string): AIAccountEntry | undefined {
        const name = this.data.defaultAccounts[context];

        if (name) {
            return this.data.accounts.find((a) => a.name === name);
        }

        // Fallback: first account
        return this.data.accounts[0];
    }

    async setDefaultAccount(context: string, accountName: string): Promise<void> {
        const exists = this.data.accounts.some((a) => a.name === accountName);

        if (!exists) {
            throw new Error(`Account "${accountName}" not found`);
        }

        await this.mutate((data) => {
            data.defaultAccounts[context] = accountName;
        });
    }

    getDefaultAccounts(): Record<string, string> {
        return { ...this.data.defaultAccounts };
    }

    // ── App settings ──

    getAppDefaults(app: string): AppDefaults | undefined {
        return this.data.apps[app]?.defaults;
    }

    async setAppDefaults(app: string, defaults: Partial<AppDefaults>): Promise<void> {
        await this.mutate((data) => {
            if (!data.apps[app]) {
                data.apps[app] = {};
            }

            const merged = { ...data.apps[app].defaults, ...defaults };

            // Remove keys explicitly set to undefined so they don't linger as JSON nulls
            for (const key of Object.keys(merged) as (keyof AppDefaults)[]) {
                if (merged[key] === undefined) {
                    delete merged[key];
                }
            }

            data.apps[app].defaults = merged;
        });
    }

    getAppConfig(app: string): AppConfig | undefined {
        return this.data.apps[app];
    }

    // ── Provider registry ──

    getProviderConfig(name: string): ProviderConfig | undefined {
        return this.data.providers[name];
    }

    getProviders(): Record<string, ProviderConfig> {
        return { ...this.data.providers };
    }

    isProviderEnabled(name: string): boolean {
        const entry = this.data.providers[name];

        // No entry = enabled by default (backward compat)
        if (!entry) {
            return true;
        }

        return entry.enabled;
    }

    async setProviderEnabled(name: string, enabled: boolean): Promise<void> {
        await this.mutate((data) => {
            if (data.providers[name]) {
                data.providers[name] = { ...data.providers[name], enabled };
            } else {
                // Create a minimal entry — envVariable will be set by caller or remain empty
                data.providers[name] = { enabled, envVariable: "" };
            }
        });
    }

    // ── HF token convenience ──

    getHfToken(): string | undefined {
        const hfAccount = this.data.accounts.find((a) => a.provider === "huggingface");
        return hfAccount?.tokens.apiKey;
    }

    async setHfToken(token: string): Promise<void> {
        await this.mutate((data) => {
            const idx = data.accounts.findIndex((a) => a.provider === "huggingface");

            if (idx >= 0) {
                data.accounts[idx] = {
                    ...data.accounts[idx],
                    tokens: { ...data.accounts[idx].tokens, apiKey: token },
                };
            } else {
                data.accounts.push({
                    name: "hf-cloud",
                    provider: "huggingface",
                    tokens: { apiKey: token },
                    apps: ["ai"],
                });
            }
        });
    }

    // ── Internal ──

    /**
     * Atomically read-modify-write the config, then refresh the in-memory cache.
     * All mutating methods delegate here. Public so callers can batch multiple updates
     * into a single disk write (e.g. refreshAccountLabels).
     */
    async mutate(updater: (data: AIConfigData) => void): Promise<void> {
        const updated = await this.storage.atomicConfigUpdate<AIConfigData>((data) => {
            // Ensure defaults exist for the fresh-from-disk data
            if (!data.accounts) {
                data.accounts = [];
            }

            if (!data.defaultAccounts) {
                data.defaultAccounts = {};
            }

            if (!data.tasks) {
                data.tasks = { ...DEFAULT_TASKS };
            }

            if (!data.apps) {
                data.apps = {};
            }

            if (!data.providers) {
                data.providers = {};
            }

            updater(data);
        });

        // Refresh in-memory cache with what was actually written to disk
        this.data = applyDefaults(updated);
    }

    /**
     * Like mutate() but the callback is async — can do I/O while holding the lock.
     * Re-reads config from disk inside the lock (prevents TOCTOU).
     * Mutate `data` in the callback; it's persisted automatically on return.
     * Use for operations that need async I/O while holding the lock (e.g. token refresh).
     */
    async withLock<T>(
        fn: (data: AIConfigData) => Promise<T>,
        timeout?: number,
    ): Promise<T> {
        return this.storage.withConfigLock(async () => {
            const fresh = await this.storage.getConfig<Partial<AIConfigData>>();
            const data = applyDefaults(fresh);

            const result = await fn(data);

            // Persist whatever the callback mutated
            await this.storage.setConfig(data);
            this.data = data;

            return result;
        }, timeout);
    }
}

import logger from "@app/logger";
import { Storage } from "@app/utils/storage/storage";
import type { AIAccountConfig, AIAccountEntry, AIProvider } from "./account-types";

export class AIConfigStorage {
    private storage = new Storage("ai-accounts");
    private cached: AIAccountConfig | null = null;

    async load(): Promise<AIAccountConfig> {
        if (this.cached) {
            return this.cached;
        }

        const raw = await this.storage.getConfig<Partial<AIAccountConfig>>();
        const config: AIAccountConfig = {
            accounts: raw?.accounts ?? [],
            defaultAccount: raw?.defaultAccount,
        };

        // Migration: if empty, try importing from tools claude config
        if (config.accounts.length === 0) {
            await this.migrateFromClaude(config);
        }

        this.cached = config;
        return config;
    }

    private async save(): Promise<void> {
        if (!this.cached) {
            return;
        }

        const snapshot = this.cached;

        await this.storage.withConfigLock(async () => {
            await this.storage.setConfig(snapshot);
        });
    }

    async getAccount(name: string): Promise<AIAccountEntry | undefined> {
        const config = await this.load();
        return config.accounts.find((a) => a.name === name);
    }

    async getAccountsByProvider(provider: AIProvider): Promise<AIAccountEntry[]> {
        const config = await this.load();
        return config.accounts.filter((a) => a.provider === provider);
    }

    async getAccountsByApp(app: string): Promise<AIAccountEntry[]> {
        const config = await this.load();
        return config.accounts.filter((a) => a.apps?.includes(app));
    }

    async addAccount(entry: AIAccountEntry): Promise<void> {
        const config = await this.load();
        const existing = config.accounts.findIndex((a) => a.name === entry.name);

        if (existing >= 0) {
            config.accounts[existing] = entry;
        } else {
            config.accounts.push(entry);
        }

        if (!config.defaultAccount) {
            config.defaultAccount = entry.name;
        }

        await this.save();
    }

    async removeAccount(name: string): Promise<void> {
        const config = await this.load();
        config.accounts = config.accounts.filter((a) => a.name !== name);

        if (config.defaultAccount === name) {
            config.defaultAccount = config.accounts[0]?.name;
        }

        await this.save();
    }

    async updateAccount(name: string, updates: Partial<AIAccountEntry>): Promise<void> {
        const config = await this.load();
        const idx = config.accounts.findIndex((a) => a.name === name);

        if (idx < 0) {
            throw new Error(`Account "${name}" not found`);
        }

        config.accounts[idx] = { ...config.accounts[idx], ...updates };
        await this.save();
    }

    async listAccounts(): Promise<AIAccountEntry[]> {
        const config = await this.load();
        return [...config.accounts];
    }

    async getDefaultAccount(): Promise<AIAccountEntry | undefined> {
        const config = await this.load();

        if (!config.defaultAccount) {
            return config.accounts[0];
        }

        return config.accounts.find((a) => a.name === config.defaultAccount);
    }

    async setDefaultAccount(name: string): Promise<void> {
        const config = await this.load();
        const exists = config.accounts.some((a) => a.name === name);

        if (!exists) {
            throw new Error(`Account "${name}" not found`);
        }

        config.defaultAccount = name;
        await this.save();
    }

    invalidate(): void {
        this.cached = null;
    }

    /**
     * Migration: import accounts from tools claude config on first load.
     * Converts existing claude accounts to AIAccountEntry with provider: "anthropic-sub".
     */
    private async migrateFromClaude(config: AIAccountConfig): Promise<void> {
        try {
            const { loadConfig } = await import("@app/claude/lib/config");
            const claudeConfig = await loadConfig();

            if (!claudeConfig.accounts || Object.keys(claudeConfig.accounts).length === 0) {
                return;
            }

            for (const [name, account] of Object.entries(claudeConfig.accounts)) {
                config.accounts.push({
                    name,
                    provider: "anthropic-sub",
                    tokens: {
                        accessToken: account.accessToken,
                        refreshToken: account.refreshToken,
                        expiresAt: account.expiresAt,
                    },
                    label: account.label,
                    apps: ["claude", "ask"],
                });
            }

            if (claudeConfig.defaultAccount) {
                config.defaultAccount = claudeConfig.defaultAccount;
            }

            if (config.accounts.length > 0) {
                logger.info(`Migrated ${config.accounts.length} account(s) from tools claude config`);
                this.cached = config;
                await this.save();
            }
        } catch (err) {
            logger.debug(`Claude config migration skipped: ${err}`);
        }
    }
}

export const aiConfigStorage = new AIConfigStorage();

import { statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { _resetMigrationStateForTest, ensureAiConfigMigrated } from "./migrate";
import { assertSafeToWriteRealConfig } from "./migration-guard";
import { type AccountRef, accountRef, type Referrer, referrersOf } from "./refs";
import { type AccountEntry, type AiConfigData, aiConfigSchema, emptyConfig } from "./schema";

export interface AccountFilter {
    provider?: string | string[];
    billing?: AccountEntry["billing"]["mode"];
    enabled?: boolean;
    tag?: string;
}

function matches(account: AccountEntry, filter: AccountFilter): boolean {
    if (filter.enabled !== undefined && account.enabled !== filter.enabled) {
        return false;
    }

    if (filter.billing !== undefined && account.billing.mode !== filter.billing) {
        return false;
    }

    if (filter.tag !== undefined && !(account.tags ?? []).includes(filter.tag)) {
        return false;
    }

    if (filter.provider !== undefined) {
        const providers = Array.isArray(filter.provider) ? filter.provider : [filter.provider];
        if (!providers.includes(account.provider)) {
            return false;
        }
    }

    return true;
}

/**
 * The single reader/writer for the unified AI config.
 *
 * Unlike the v3 `AIConfig` singleton, which captured the file once per process
 * and never looked again, this store stamps the file's mtime on load and
 * re-reads when it changes. That staleness is why a long-running ai-proxy or
 * dashboard kept serving credentials that a `tools claude login` in another
 * terminal had already replaced.
 */
export class AiConfigStore {
    private static instance: AiConfigStore | null = null;

    private constructor(
        private readonly storage: Storage,
        private config: AiConfigData,
        private mtimeMs: number
    ) {}

    static async load(): Promise<AiConfigStore> {
        if (AiConfigStore.instance) {
            await AiConfigStore.instance.refreshIfStale();
            return AiConfigStore.instance;
        }

        await ensureAiConfigMigrated();

        const storage = new Storage("ai");
        const { config, mtimeMs } = await AiConfigStore.readFrom(storage);
        AiConfigStore.instance = new AiConfigStore(storage, config, mtimeMs);
        return AiConfigStore.instance;
    }

    static invalidate(): void {
        AiConfigStore.instance = null;
        _resetMigrationStateForTest();
    }

    private static async readFrom(storage: Storage): Promise<{ config: AiConfigData; mtimeMs: number }> {
        const raw = await storage.getConfig<Record<string, unknown>>();
        if (!raw || Object.keys(raw).length === 0) {
            return { config: emptyConfig(), mtimeMs: 0 };
        }

        const parsed = aiConfigSchema.safeParse(raw);
        if (!parsed.success) {
            throw new Error(
                `~/.genesis-tools/ai/config.json is not a valid v4 config: ${parsed.error.issues
                    .map((issue) => `${issue.path.join(".")} ${issue.message}`)
                    .join("; ")}`
            );
        }

        return { config: parsed.data, mtimeMs: AiConfigStore.mtimeOf(storage) };
    }

    private static mtimeOf(storage: Storage): number {
        try {
            return statSync(storage.getConfigPath()).mtimeMs;
        } catch (err) {
            logger.debug({ err }, "ai config not on disk yet");
            return 0;
        }
    }

    /** Re-read when another process has written since we loaded. */
    private async refreshIfStale(): Promise<void> {
        const current = AiConfigStore.mtimeOf(this.storage);
        if (current === this.mtimeMs) {
            return;
        }

        const { config, mtimeMs } = await AiConfigStore.readFrom(this.storage);
        this.config = config;
        this.mtimeMs = mtimeMs;
        logger.debug({ mtimeMs }, "reloaded ai config after external write");
    }

    data(): Readonly<AiConfigData> {
        return this.config;
    }

    /** Id match first, then a unique name. An ambiguous name is an error, not a guess. */
    account(idOrName: string): AccountEntry | undefined {
        const byId = this.config.accounts.find((entry) => entry.id === idOrName);
        if (byId) {
            return byId;
        }

        const byName = this.config.accounts.filter((entry) => entry.name === idOrName);
        if (byName.length > 1) {
            throw new Error(
                `Account name "${idOrName}" is ambiguous (${byName.length} accounts share it). Use the id: ${byName
                    .map((entry) => entry.id)
                    .join(", ")}.`
            );
        }

        return byName[0];
    }

    accounts(filter?: AccountFilter): AccountEntry[] {
        if (!filter) {
            return [...this.config.accounts];
        }

        return this.config.accounts.filter((account) => matches(account, filter));
    }

    ref(idOrName: string): AccountRef | undefined {
        const account = this.account(idOrName);
        return account ? accountRef(account.id) : undefined;
    }

    referrers(id: string): Promise<Referrer[]> {
        return referrersOf(this.config, id);
    }

    /**
     * Mutate under the config file lock, re-reading first so a concurrent writer's
     * changes are not lost. Callers that also write the vault must nest that work
     * INSIDE this callback: config lock first, vault lock second, always in that
     * order, or two processes rotating a token can deadlock.
     */
    async mutate(fn: (data: AiConfigData) => void): Promise<void> {
        await this.withLock(async (data) => {
            fn(data);
        });
    }

    async withLock<T>(fn: (data: AiConfigData) => Promise<T>): Promise<T> {
        return this.storage.withConfigLock(async () => {
            const { config } = await AiConfigStore.readFrom(this.storage);
            const result = await fn(config);

            const validated = aiConfigSchema.parse(config);
            // Last line of defence: every v4 write in the codebase funnels through
            // here, so even a mis-gated migration cannot reach the real config.
            assertSafeToWriteRealConfig();
            await this.storage.setConfig(validated);
            this.config = validated;
            this.mtimeMs = AiConfigStore.mtimeOf(this.storage);
            return result;
        });
    }
}

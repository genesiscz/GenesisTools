import { statSync } from "node:fs";
import type { AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { _resetMigrationStateForTest, ensureAiConfigMigrated } from "./migrate";
import { assertSafeToWriteRealConfig } from "./migration-guard";
import { convertConfig } from "./migrations/2026-08-configV4";
import { type AccountRef, accountRef, type Referrer, referrersOf } from "./refs";
import { type AccountEntry, type AiConfigData, aiConfigSchema, CONFIG_VERSION, emptyConfig } from "./schema";

/**
 * Read a pre-v4 config into the v4 shape, in memory only.
 *
 * Returns undefined when the file is not a recognisable older config, so a
 * genuinely corrupt file still reports the schema errors instead of being
 * silently treated as empty.
 */
export function adaptOlderConfig(raw: Record<string, unknown>): AiConfigData | undefined {
    const version = raw.version ?? raw._schemaVersion;

    if (version === undefined || Number(version) >= CONFIG_VERSION) {
        return undefined;
    }

    try {
        const converted = convertConfig(raw as unknown as V3ConfigData);
        logger.debug({ version }, "read an unmigrated AI config through the v3 adapter");
        return aiConfigSchema.parse(converted);
    } catch (err) {
        logger.debug({ err, version }, "older AI config could not be adapted");
        return undefined;
    }
}

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
            // An unmigrated file is not a broken file. The migration can legitimately
            // be deferred (a worktree build, an explicit opt-out), and when it is,
            // every AI tool must still read the config rather than die on its shape.
            // Converting in memory is read-only: nothing is written back here.
            const adapted = adaptOlderConfig(raw);
            if (adapted) {
                return { config: adapted, mtimeMs: AiConfigStore.mtimeOf(storage) };
            }

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
    /**
     * The callback may be async, and it must be awaited. TypeScript accepts an
     * `async` function wherever a `void`-returning one is expected, so a
     * `fn(data)` without an await compiled fine and then applied its mutations
     * AFTER the schema parse and the write — the change vanished with no error
     * and no log.
     */
    async mutate(fn: (data: AiConfigData) => void | Promise<void>): Promise<void> {
        await this.withLock(async (data) => {
            await fn(data);
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

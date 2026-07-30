import { statSync } from "node:fs";
import type { AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { _resetMigrationStateForTest, ensureAiConfigMigrated } from "./migrate";
import { writeDefaultsSnapshot } from "./defaults-snapshot";
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
/**
 * What "the file has not changed" means here.
 *
 * mtime alone was the whole test, and mtime alone can repeat: a filesystem with
 * coarse timestamps, or any writer that preserves them (an editor's atomic
 * replace, `rsync -t`, a restore from backup), produces two different configs
 * that compare equal, and the store then keeps serving the stale snapshot
 * indefinitely. Size is free from the same `stat` and catches every such case
 * where the content length moved.
 */
interface FileStamp {
    mtimeMs: number;
    size: number;
}

const MISSING_FILE: FileStamp = { mtimeMs: 0, size: 0 };

export class AiConfigStore {
    private static instance: AiConfigStore | null = null;
    /** First construction in flight, so concurrent `load()` calls share one. */
    private static loading: Promise<AiConfigStore> | null = null;

    private constructor(
        private readonly storage: Storage,
        private config: AiConfigData,
        private stamp: FileStamp
    ) {}

    static async load(): Promise<AiConfigStore> {
        if (AiConfigStore.instance) {
            await AiConfigStore.instance.refreshIfStale();
            return AiConfigStore.instance;
        }

        // The instance check and the read below are separated by an await, so two
        // callers racing the first load both saw `instance === null`, both ran the
        // migration and built a store, and each got a DIFFERENT object while only
        // the last assignment won the static field. Whoever held the loser then
        // mutated a detached in-memory view. The in-flight promise makes the first
        // construction the one every caller awaits.
        AiConfigStore.loading ??= AiConfigStore.build();

        try {
            return await AiConfigStore.loading;
        } finally {
            AiConfigStore.loading = null;
        }
    }

    private static async build(): Promise<AiConfigStore> {
        await ensureAiConfigMigrated();

        const storage = new Storage("ai");
        const { config, stamp } = await AiConfigStore.readFrom(storage);
        AiConfigStore.instance = new AiConfigStore(storage, config, stamp);
        return AiConfigStore.instance;
    }

    static invalidate(): void {
        AiConfigStore.instance = null;
        AiConfigStore.loading = null;
        _resetMigrationStateForTest();
    }

    private static async readFrom(storage: Storage): Promise<{ config: AiConfigData; stamp: FileStamp }> {
        const raw = await storage.getConfig<Record<string, unknown>>();
        if (!raw || Object.keys(raw).length === 0) {
            return { config: emptyConfig(), stamp: MISSING_FILE };
        }

        const parsed = aiConfigSchema.safeParse(raw);
        if (!parsed.success) {
            // An unmigrated file is not a broken file. The migration can legitimately
            // be deferred (a worktree build, an explicit opt-out), and when it is,
            // every AI tool must still read the config rather than die on its shape.
            // Converting in memory is read-only: nothing is written back here.
            const adapted = adaptOlderConfig(raw);
            if (adapted) {
                return { config: adapted, stamp: AiConfigStore.stampOf(storage) };
            }

            throw new Error(
                `~/.genesis-tools/ai/config.json is not a valid v4 config: ${parsed.error.issues
                    .map((issue) => `${issue.path.join(".")} ${issue.message}`)
                    .join("; ")}`
            );
        }

        return { config: parsed.data, stamp: AiConfigStore.stampOf(storage) };
    }

    private static stampOf(storage: Storage): FileStamp {
        try {
            const stat = statSync(storage.getConfigPath());

            return { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch (err) {
            logger.debug({ err }, "ai config not on disk yet");
            return MISSING_FILE;
        }
    }

    /** Re-read when another process has written since we loaded. */
    private async refreshIfStale(): Promise<void> {
        const current = AiConfigStore.stampOf(this.storage);
        if (current.mtimeMs === this.stamp.mtimeMs && current.size === this.stamp.size) {
            return;
        }

        const { config, stamp } = await AiConfigStore.readFrom(this.storage);
        this.config = config;
        this.stamp = stamp;
        logger.debug({ stamp }, "reloaded ai config after external write");
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

            // The `_schemaVersion: 3` stamp is the pre-v4-binary armor (schema.ts).
            const validated = { ...aiConfigSchema.parse(config), _schemaVersion: 3 as const };
            // Last line of defence: every v4 write in the codebase funnels through
            // here, so even a mis-gated migration cannot reach the real config.
            assertSafeToWriteRealConfig();
            await this.storage.setConfig(validated);
            // Keep the copy old binaries cannot touch in step; the hybrid repair
            // restores `defaults` from it after an old-code rewrite.
            writeDefaultsSnapshot(this.storage, validated.defaults);
            this.config = validated;
            this.stamp = AiConfigStore.stampOf(this.storage);
            return result;
        });
    }
}

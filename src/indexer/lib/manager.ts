import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { IndexerCallbacks, SyncStats } from "./events";
import { Indexer } from "./indexer";
import { emptyStats, type IndexConfig, type IndexMeta } from "./types";

interface ManagerConfig {
    indexes: Record<string, IndexConfig>;
}

const DEFAULT_CONFIG: ManagerConfig = { indexes: {} };

export class IndexerManager {
    private storage: Storage;
    private indexers: Map<string, Indexer>;

    private constructor(storage: Storage) {
        this.storage = storage;
        this.indexers = new Map();
    }

    static async load(): Promise<IndexerManager> {
        const storage = new Storage("indexer");
        await storage.ensureDirs();
        const manager = new IndexerManager(storage);
        return manager;
    }

    async addIndex(config: IndexConfig, callbacks?: IndexerCallbacks): Promise<Indexer> {
        const managerConfig = await this.loadConfig();

        if (managerConfig.indexes[config.name]) {
            throw new Error(`Index "${config.name}" already exists`);
        }

        managerConfig.indexes[config.name] = config;
        await this.saveConfig(managerConfig);

        const indexer = await Indexer.create(config);
        this.indexers.set(config.name, indexer);

        await indexer.sync(callbacks);

        return indexer;
    }

    async removeIndex(name: string): Promise<void> {
        const managerConfig = await this.loadConfig();

        if (!managerConfig.indexes[name]) {
            throw new Error(`Index "${name}" not found`);
        }

        const cached = this.indexers.get(name);

        if (cached) {
            await cached.close();
            this.indexers.delete(name);
        }

        delete managerConfig.indexes[name];
        await this.saveConfig(managerConfig);

        const indexDir = join(this.storage.getBaseDir(), name);

        if (existsSync(indexDir)) {
            rmSync(indexDir, { recursive: true, force: true });
        }
    }

    async getIndex(name: string): Promise<Indexer> {
        const cached = this.indexers.get(name);

        if (cached) {
            return cached;
        }

        const managerConfig = await this.loadConfig();
        const config = managerConfig.indexes[name];

        if (!config) {
            throw new Error(`Index "${name}" not found`);
        }

        const indexer = await Indexer.create(config);
        this.indexers.set(name, indexer);
        return indexer;
    }

    listIndexes(): IndexMeta[] {
        const configPath = this.storage.getConfigPath();

        if (!existsSync(configPath)) {
            return [];
        }

        const configText = readFileSync(configPath, "utf-8");
        const managerConfig = SafeJSON.parse(configText) as ManagerConfig;

        if (!managerConfig?.indexes) {
            return [];
        }

        const result: IndexMeta[] = [];

        for (const [name, config] of Object.entries(managerConfig.indexes)) {
            const dbPath = join(this.storage.getBaseDir(), name, "index.db");

            if (!existsSync(dbPath)) {
                result.push({
                    name,
                    config,
                    stats: emptyStats(),
                    lastSyncAt: null,
                    createdAt: 0,
                });
                continue;
            }

            try {
                const db = new Database(dbPath, { readonly: true });
                const row = db.query("SELECT value FROM index_meta WHERE key = 'meta'").get() as {
                    value: string;
                } | null;
                db.close();

                if (row) {
                    const meta = SafeJSON.parse(row.value) as IndexMeta;
                    result.push(meta);
                } else {
                    result.push({
                        name,
                        config,
                        stats: emptyStats(),
                        lastSyncAt: null,
                        createdAt: 0,
                    });
                }
            } catch (err) {
                console.debug(`Failed to read metadata for index "${name}":`, err);
                result.push({
                    name,
                    config,
                    stats: emptyStats(),
                    lastSyncAt: null,
                    createdAt: 0,
                });
            }
        }

        return result;
    }

    async rebuildIndex(name: string, callbacks?: IndexerCallbacks): Promise<SyncStats> {
        const indexer = await this.getIndex(name);
        return indexer.reindex(callbacks);
    }

    /** Request cancellation of an in-progress sync (in-process only) */
    async stopIndex(name: string): Promise<boolean> {
        const cached = this.indexers.get(name);

        if (!cached) {
            return false;
        }

        cached.requestCancellation();
        return true;
    }

    /** Check for indexes that were interrupted and may need resuming */
    getInterruptedIndexes(): Array<{ name: string; meta: IndexMeta }> {
        const indexes = this.listIndexes();
        return indexes
            .filter((meta) => meta.indexingStatus === "in-progress" || meta.indexingStatus === "cancelled")
            .map((meta) => ({ name: meta.name, meta }));
    }

    /** Resume an interrupted index by running incremental sync */
    async resumeIndex(name: string, callbacks?: IndexerCallbacks): Promise<SyncStats> {
        const indexer = await this.getIndex(name);
        return indexer.sync(callbacks);
    }

    async syncAll(): Promise<Map<string, SyncStats>> {
        const managerConfig = await this.loadConfig();
        const results = new Map<string, SyncStats>();

        for (const name of Object.keys(managerConfig.indexes)) {
            const indexer = await this.getIndex(name);
            const stats = await indexer.sync();
            results.set(name, stats);
        }

        return results;
    }

    getIndexNames(): string[] {
        const configPath = this.storage.getConfigPath();

        if (!existsSync(configPath)) {
            return [];
        }

        const configText = readFileSync(configPath, "utf-8");
        const managerConfig = SafeJSON.parse(configText) as ManagerConfig;

        if (!managerConfig?.indexes) {
            return [];
        }

        return Object.keys(managerConfig.indexes);
    }

    async close(): Promise<void> {
        for (const indexer of this.indexers.values()) {
            await indexer.close();
        }

        this.indexers.clear();
    }

    private async loadConfig(): Promise<ManagerConfig> {
        const config = await this.storage.getConfig<ManagerConfig>();
        return config ?? { ...DEFAULT_CONFIG };
    }

    private async saveConfig(config: ManagerConfig): Promise<void> {
        await this.storage.setConfig(config);
    }
}

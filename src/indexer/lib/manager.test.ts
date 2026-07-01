import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { IndexerManager } from "./manager";
import { _resetIndexerStorageForTesting } from "./storage";
import type { IndexConfig } from "./types";

describe("listIndexes handle cleanup", () => {
    let previousHome: string | undefined;
    let homeDir: string;
    let closeCalls = 0;
    let originalClose: typeof Database.prototype.close;

    beforeEach(() => {
        previousHome = env.get("GENESIS_TOOLS_HOME");
        homeDir = mkdtempSync(join(tmpdir(), "indexer-manager-test-"));
        env.testing.set("GENESIS_TOOLS_HOME", homeDir);
        _resetIndexerStorageForTesting();

        closeCalls = 0;
        originalClose = Database.prototype.close;
        Database.prototype.close = function (this: Database) {
            closeCalls++;
            return originalClose.call(this);
        };
    });

    afterEach(() => {
        Database.prototype.close = originalClose;
        if (previousHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", previousHome);
        }
        _resetIndexerStorageForTesting();
        rmSync(homeDir, { recursive: true, force: true });
    });

    test("closes the db handle even when metadata parsing throws", async () => {
        const indexName = "leak-test-index";
        const indexerDir = join(homeDir, ".genesis-tools", "indexer");
        const indexDir = join(indexerDir, indexName);
        const dbPath = join(indexDir, "index.db");

        mkdirSync(indexDir, { recursive: true });

        const seedDb = new Database(dbPath);
        seedDb.run(`CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT)`);
        seedDb.run(`INSERT INTO index_meta (key, value) VALUES ('meta', 'not-valid-json')`);
        seedDb.close();

        const config: IndexConfig = {
            name: indexName,
            baseDir: "",
            type: "code",
            respectGitIgnore: false,
            chunking: "auto",
            embedding: { enabled: false },
            watch: { strategy: "merkle" },
        };

        writeFileSync(
            join(indexerDir, "config.json"),
            SafeJSON.stringify({ indexes: { [indexName]: config } }, null, 2)
        );

        const manager = await IndexerManager.load();
        closeCalls = 0;
        manager.listIndexes();

        expect(closeCalls).toBe(1);
    });
});

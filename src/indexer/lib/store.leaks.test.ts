import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { ensureExtensionCapableSQLite } from "@app/utils/search/stores/sqlite-vec-loader";
import { _resetIndexerStorageForTesting, getIndexerStorage, sanitizeName } from "./storage";
import { createIndexStore } from "./store";

ensureExtensionCapableSQLite();

describe("searchIndexReadonly handle cleanup", () => {
    let previousHome: string | undefined;
    let homeDir: string;
    let closeCalls = 0;
    let originalClose: typeof Database.prototype.close;
    const indexName = `readonly-leak-${Date.now()}`;

    beforeEach(() => {
        previousHome = env.get("GENESIS_TOOLS_HOME");
        homeDir = mkdtempSync(join(tmpdir(), "indexer-store-readonly-test-"));
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
        rmSync(getIndexerStorage().getIndexDir(indexName), { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
        mock.restore();
    });

    test("closes the db handle when assertVecExtensionAvailable throws", async () => {
        const indexDir = getIndexerStorage().getIndexDir(indexName);
        const dbPath = join(indexDir, "index.db");
        mkdirSync(indexDir, { recursive: true });

        const tableName = sanitizeName(indexName);
        const seedDb = new Database(dbPath);
        seedDb.run(`CREATE TABLE ${tableName}_vec (id INTEGER)`);
        seedDb.close();
        closeCalls = 0;

        mock.module("@app/utils/search/stores/sqlite-vec-loader", () => ({
            ensureExtensionCapableSQLite,
            assertVecExtensionAvailable: () => {
                throw new Error("forced vec extension failure");
            },
            loadSqliteVec: () => false,
        }));

        const { searchIndexReadonly: searchWithMock } = await import("./store");

        await expect(searchWithMock(indexName, "query")).rejects.toThrow("forced vec extension failure");
        expect(closeCalls).toBe(1);
    });
});

describe("createIndexStore handle cleanup", () => {
    let previousHome: string | undefined;
    let homeDir: string;
    let closeCalls = 0;
    let originalClose: typeof Database.prototype.close;
    const indexName = `create-leak-${Date.now()}`;

    beforeEach(() => {
        previousHome = env.get("GENESIS_TOOLS_HOME");
        homeDir = mkdtempSync(join(tmpdir(), "indexer-store-create-test-"));
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
        rmSync(getIndexerStorage().getIndexDir(indexName), { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
    });

    test("closes the db handle when Qdrant connection throws after db is opened", async () => {
        await expect(
            createIndexStore({
                name: indexName,
                baseDir: "",
                type: "code",
                respectGitIgnore: false,
                chunking: "auto",
                embedding: { enabled: false },
                watch: { strategy: "merkle" },
                storage: {
                    vectorDriver: "qdrant",
                    qdrant: { url: "http://127.0.0.1:1" },
                },
            })
        ).rejects.toThrow();

        expect(closeCalls).toBeGreaterThanOrEqual(1);
    });
});

import { describe, expect, test } from "bun:test";
import type { IdbDump } from "@genesiscz/utils/chrome-devtools/storage";
import { biggestIdbRows, idbStoreLines, parseIdbKey, reactMatchersFrom } from "./inspect-data.ts";

const dump: IdbDump = {
    origin: "http://127.0.0.1:47361",
    databases: [
        {
            name: "app-db",
            version: 1,
            stores: [
                {
                    name: "blobs",
                    keyPath: null,
                    autoIncrement: false,
                    indexes: [],
                    count: 3,
                    jsonBytes: 360_150,
                    rows: [
                        { key: "big", jsonBytes: 360_002, truncated: true, preview: '"xxxx' },
                        { key: 7, jsonBytes: 100, value: { a: 1 } },
                        { key: ["a", 1], jsonBytes: 48, value: "small" },
                    ],
                },
                { name: "empty", keyPath: "id", autoIncrement: true, indexes: [], count: 0, jsonBytes: 0, rows: [] },
            ],
        },
        { name: "broken", version: 2, stores: [], error: "VersionError" },
    ],
};

describe("idbStoreLines", () => {
    test("one line per store, and a database that failed to open still gets a line with its error", () => {
        expect(idbStoreLines(dump)).toEqual([
            { db: "app-db", store: "blobs", rows: 3, bytes: 360_150 },
            { db: "app-db", store: "empty", rows: 0, bytes: 0 },
            { db: "broken", store: null, rows: 0, bytes: null, error: "VersionError" },
        ]);
    });

    test("a keys-only dump has no byte figures, so the column is unknown rather than zero", () => {
        const keysOnly: IdbDump = {
            origin: dump.origin,
            databases: [
                {
                    name: "app-db",
                    version: 1,
                    stores: [
                        {
                            name: "blobs",
                            keyPath: null,
                            autoIncrement: false,
                            indexes: [],
                            count: 1,
                            jsonBytes: 0,
                            rows: [{ key: "big" }],
                        },
                    ],
                },
            ],
        };
        expect(idbStoreLines(keysOnly)[0].bytes).toBeNull();
    });
});

describe("biggestIdbRows", () => {
    test("largest JSON first across every store, cut to the limit", () => {
        expect(biggestIdbRows(dump, 2)).toEqual([
            { db: "app-db", store: "blobs", key: "big", bytes: 360_002, preview: '"xxxx' },
            { db: "app-db", store: "blobs", key: 7, bytes: 100, preview: `{"a":1}` },
        ]);
    });
});

describe("parseIdbKey", () => {
    test("digits are a number key, a double-quoted value is a string key, anything else stays a string", () => {
        expect(parseIdbKey("42")).toBe(42);
        expect(parseIdbKey("-1.5")).toBe(-1.5);
        expect(parseIdbKey('"42"')).toBe("42");
        expect(parseIdbKey("user:42")).toBe("user:42");
    });
});

describe("reactMatchersFrom", () => {
    test("each --function and --path is its own matcher named by its path, sharing --component", () => {
        expect(
            reactMatchersFrom({
                functions: ["client.getQueryCache", "store.getState"],
                paths: ["value.user"],
                component: "Provider",
            })
        ).toEqual([
            { name: "client.getQueryCache", hasFunction: "client.getQueryCache", component: "Provider" },
            { name: "store.getState", hasFunction: "store.getState", component: "Provider" },
            { name: "value.user", hasPath: "value.user", component: "Provider" },
        ]);
    });

    test("--component alone matches that component's props", () => {
        expect(reactMatchersFrom({ functions: [], paths: [], component: "QueryClientProvider" })).toEqual([
            { name: "QueryClientProvider", component: "QueryClientProvider" },
        ]);
    });

    test("--expose lands on the single matcher, and is refused when there are several", () => {
        expect(reactMatchersFrom({ functions: ["store.getState"], paths: [], expose: "__store" })).toEqual([
            { name: "store.getState", hasFunction: "store.getState", exposeAs: "__store" },
        ]);
        expect(reactMatchersFrom({ functions: ["a.b", "c.d"], paths: [], expose: "__x" })).toEqual({
            error: "--expose names ONE window slot, so it needs exactly one matcher; got 2.",
        });
    });

    test("nothing to look for is an error, never a walk that matches everything", () => {
        expect(reactMatchersFrom({ functions: [], paths: [] })).toEqual({
            error: "react find needs at least one --function, --path or --component.",
        });
    });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodingsFor, probeIndexedDb } from "./probe";

describe("probeIndexedDb", () => {
    test("finds utf8 and utf16le needles in leveldb files", () => {
        const root = mkdtempSync(join(tmpdir(), "ms-teams-probe-"));
        const leveldb = join(root, "https_teams.microsoft.com_0.indexeddb.leveldb");
        mkdirSync(leveldb, { recursive: true });
        writeFileSync(
            join(leveldb, "000003.ldb"),
            Buffer.concat([Buffer.from("xx"), Buffer.from("hello-chat", "utf8")])
        );
        writeFileSync(
            join(leveldb, "000004.ldb"),
            Buffer.concat([Buffer.from("yy"), Buffer.from("other-title", "utf16le")])
        );

        const utf8 = probeIndexedDb({ needle: "hello-chat", indexedDbDir: root });
        expect(utf8.hits.some((h) => h.encoding === "utf8")).toBe(true);

        const utf16 = probeIndexedDb({ needle: "other-title", indexedDbDir: root });
        expect(utf16.hits.some((h) => h.encoding === "utf16le")).toBe(true);

        const miss = probeIndexedDb({ needle: "not-present", indexedDbDir: root });
        expect(miss.hits).toEqual([]);
        expect(miss.filesScanned).toBe(2);
    });

    test("encodingsFor emits both buffers", () => {
        const enc = encodingsFor("abc");
        expect(enc.map((e) => e.encoding)).toEqual(["utf8", "utf16le"]);
        expect(enc[0]?.buf.equals(Buffer.from("abc", "utf8"))).toBe(true);
    });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyMoves,
    asideMoves,
    cacheMovePlan,
    classifyBackup,
    destDirFor,
    existingMoves,
    idbMovePlan,
    listBackups,
    restorePlan,
    runRepairMove,
} from "./repair";

function fakeTree(): { root: string; tmp: string; profile: string } {
    const root = mkdtempSync(join(tmpdir(), "ms-teams-root-"));
    const tmp = mkdtempSync(join(tmpdir(), "ms-teams-tmp-"));
    const eb = join(root, "EBWebView");
    const profile = join(eb, "WV2Profile_tfw");
    const idb = join(profile, "IndexedDB");
    mkdirSync(idb, { recursive: true });
    mkdirSync(join(profile, "Cookies"), { recursive: true });
    mkdirSync(join(profile, "Local Storage"), { recursive: true });
    mkdirSync(join(profile, "Session Storage"), { recursive: true });
    mkdirSync(join(profile, "Service Worker", "CacheStorage"), { recursive: true });
    mkdirSync(join(eb, "ShaderCache"), { recursive: true });
    mkdirSync(join(idb, "https_teams.microsoft.com_0.indexeddb.leveldb"), { recursive: true });
    mkdirSync(join(idb, "https_teams.microsoft.com_0.indexeddb.blob"), { recursive: true });
    writeFileSync(join(profile, "Cookies", "Cookies"), "auth");
    writeFileSync(join(idb, "https_teams.microsoft.com_0.indexeddb.leveldb", "LOG"), "messages");
    return { root, tmp, profile };
}

describe("repair plans", () => {
    test("cache plan tags tfw vs eb so restore is unambiguous", () => {
        const { root, profile } = fakeTree();
        const eb = join(root, "EBWebView");
        const plan = existingMoves(cacheMovePlan(eb, profile));
        expect(plan.some((p) => p.destName === "tfw__Service Worker")).toBe(true);
        expect(plan.some((p) => p.destName === "eb__ShaderCache")).toBe(true);
    });

    test("idb plan only takes teams.microsoft.com origins", () => {
        const { profile } = fakeTree();
        const indexedDb = join(profile, "IndexedDB");
        mkdirSync(join(indexedDb, "https_login.microsoftonline.com_0.indexeddb.leveldb"), { recursive: true });
        const plan = idbMovePlan(indexedDb, readdirSync(indexedDb));
        expect(plan.every((p) => p.destName.startsWith("https_teams.microsoft.com_"))).toBe(true);
        expect(plan).toHaveLength(2);
    });
});

describe("move + restore roundtrip", () => {
    test("idb move leaves Cookies and restores both folders", () => {
        const { root, tmp, profile } = fakeTree();
        const eb = join(root, "EBWebView");
        const indexedDb = join(profile, "IndexedDB");
        const dest = destDirFor("idb", 111, tmp);
        mkdirSync(dest, { recursive: true });
        const plan = idbMovePlan(indexedDb, readdirSync(indexedDb));
        applyMoves(
            plan.map((item) => ({ src: item.src, dest: join(dest, item.destName) })),
            false
        );
        expect(readdirSync(indexedDb)).toEqual([]);
        expect(readdirSync(join(profile, "Cookies"))).toContain("Cookies");

        const entries = readdirSync(dest);
        expect(classifyBackup(entries)).toBe("idb");
        applyMoves(restorePlan({ dest, entries, eb, profile }), false);
        expect(readdirSync(indexedDb).sort()).toEqual([
            "https_teams.microsoft.com_0.indexeddb.blob",
            "https_teams.microsoft.com_0.indexeddb.leveldb",
        ]);
    });
});

describe("restore after Teams regenerated the directories", () => {
    // Composed the way runRestore composes it; runRestore itself refuses to run
    // while a real Teams is up, so it cannot be driven from a unit test.
    test("moves the regenerated copy aside as a listed backup, then restores", () => {
        const { tmp, profile } = fakeTree();
        const eb = join(profile, "..");
        const indexedDb = join(profile, "IndexedDB");
        const dest = destDirFor("idb", 333, tmp);
        mkdirSync(dest, { recursive: true });
        applyMoves(
            idbMovePlan(indexedDb, readdirSync(indexedDb)).map((item) => ({
                src: item.src,
                dest: join(dest, item.destName),
            })),
            false
        );
        expect(readdirSync(indexedDb)).toEqual([]);

        // Relaunched Teams writes a fresh, non-empty database at the same path.
        const regenerated = join(indexedDb, "https_teams.microsoft.com_0.indexeddb.leveldb");
        mkdirSync(regenerated, { recursive: true });
        writeFileSync(join(regenerated, "LOG"), "fresh");

        const entries = readdirSync(dest);
        const plan = restorePlan({ dest, entries, eb, profile });
        const asideDir = `${dest}-replaced-444`;
        const aside = asideMoves(plan, entries, asideDir);
        expect(aside).toHaveLength(1);
        mkdirSync(asideDir, { recursive: true });
        applyMoves([...aside, ...plan], false);

        expect(readFileSync(join(regenerated, "LOG"), "utf8")).toBe("messages");
        expect(readFileSync(join(asideDir, "https_teams.microsoft.com_0.indexeddb.leveldb", "LOG"), "utf8")).toBe(
            "fresh"
        );
        expect(listBackups(tmp)).toContain(asideDir);
    });
});

describe("runRepairMove dry-run", () => {
    test("does not move files", () => {
        const { root, tmp, profile } = fakeTree();
        const indexedDb = join(profile, "IndexedDB");
        const before = readdirSync(indexedDb).sort();
        const result = runRepairMove({ kind: "idb", root, tmpDir: tmp, ts: 222, dryRun: true });
        expect(result.lines.some((line) => line.startsWith("DRY "))).toBe(true);
        expect(readdirSync(indexedDb).sort()).toEqual(before);
        expect(result.auth.find((row) => row.name === "Cookies")?.ok).toBe(true);
    });
});

describe("CLI dry-run", () => {
    test("repair idb --dry-run does not require --yes", () => {
        const { root, tmp, profile } = fakeTree();
        const indexedDb = join(profile, "IndexedDB");
        const before = readdirSync(indexedDb).sort();
        const script = join(import.meta.dir, "../index.ts");
        const r = spawnSync("bun", [script, "repair", "idb", "--dry-run", "--root", root, "--tmp", tmp], {
            encoding: "utf8",
        });
        expect(r.status).toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain("DRY ");
        expect(readdirSync(indexedDb).sort()).toEqual(before);
    });

    test("repair cache without --yes exits 1", () => {
        const { root, tmp } = fakeTree();
        const script = join(import.meta.dir, "../index.ts");
        const r = spawnSync("bun", [script, "repair", "cache", "--root", root, "--tmp", tmp], { encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(`${r.stdout}${r.stderr}`).toContain("--yes");
    });
});

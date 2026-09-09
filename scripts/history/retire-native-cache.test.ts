import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "@genesiscz/utils/paths";
import { inspectNativeCache, retireNativeCache } from "./retire-native-cache";

function fixture(): { toolsHome: string; target: string; manifestDirectory: string } {
    const toolsHome = join(tmpdir(), `retire-native-${crypto.randomUUID()}`);
    const target = join(toolsHome, ".genesis-tools", "native-history");
    const manifestDirectory = join(toolsHome, "manifests");
    mkdirSync(target, { recursive: true });
    const db = new Database(join(target, "index.db"));

    for (const table of [
        "native_sources",
        "native_sessions",
        "native_messages",
        "native_issues",
        "native_records",
        "native_text_content",
    ]) {
        db.run(`CREATE TABLE ${table} (id TEXT)`);
    }
    db.run("CREATE VIRTUAL TABLE native_text_fts USING fts5(body, content='native_text_content')");
    db.run("CREATE TABLE _migrations (id TEXT PRIMARY KEY)");
    db.run(
        "INSERT INTO _migrations VALUES ('native_history:native-history-v1'), ('native_history:native-history-records-v2')"
    );
    db.close();
    return { toolsHome, target, manifestDirectory };
}

/**
 * The irreversible primitive itself, recorded AND thrown from: a path that reaches deletion when
 * it must not fails loudly here instead of passing because the fixtures happened to survive.
 */
function refusedRemoval(): { remove: (path: string) => void; paths: string[] } {
    const paths: string[] = [];
    return {
        paths,
        remove: (path: string) => {
            paths.push(path);
            throw new Error(`deletion must not be reached: ${path}`);
        },
    };
}

test("retirement defaults to a read-only report", () => {
    const value = fixture();
    const before = Bun.file(join(value.target, "index.db")).size;
    const deletion = refusedRemoval();
    const result = retireNativeCache({
        toolsHome: value.toolsHome,
        manifestDirectory: value.manifestDirectory,
        confirmDelete: false,
        processInspector: () => [],
        remove: deletion.remove,
    });

    expect(result.deleted).toBe(false);
    expect(deletion.paths).toEqual([]);
    expect(result.report).toMatchObject({ exists: true, schemaMatches: true, bytes: before });
    expect(existsSync(value.target)).toBe(true);
    expect(existsSync(value.manifestDirectory)).toBe(false);
});

test("a confirmed retirement deletes the quarantine copy and nothing else", () => {
    // The negative control for the refusal tests: normal use must still REACH the primitive, with
    // the renamed quarantine path, never the live target or anything above it.
    const value = fixture();
    const removed: string[] = [];
    const result = retireNativeCache({
        toolsHome: value.toolsHome,
        manifestDirectory: value.manifestDirectory,
        confirmDelete: true,
        processInspector: () => [],
        remove: (path) => {
            removed.push(path);
            rmSync(path, { recursive: true });
        },
    });

    expect(result.deleted).toBe(true);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(join(dirname(value.target), basename(removed[0] ?? "")));
    expect(basename(removed[0] ?? "")).toStartWith(".native-history-retiring-");
    expect(removed[0]).not.toBe(value.target);
    expect(existsSync(removed[0] ?? "")).toBe(false);
    expect(existsSync(join(value.toolsHome, ".genesis-tools"))).toBe(true);
});

test("cleanup never reaches deletion when ownership cannot be verified", () => {
    const value = fixture();
    const deletion = refusedRemoval();

    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            manifestDirectory: value.manifestDirectory,
            confirmDelete: true,
            processInspector: () => "unknown",
            remove: deletion.remove,
        })
    ).toThrow("could not be verified");
    expect(deletion.paths).toEqual([]);
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup never reaches deletion while a process holds the cache open", () => {
    const value = fixture();
    const deletion = refusedRemoval();

    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            manifestDirectory: value.manifestDirectory,
            confirmDelete: true,
            processInspector: () => [{ pid: 321, command: "fixture-reader" }],
            remove: deletion.remove,
        })
    ).toThrow("still have the cache open");
    expect(deletion.paths).toEqual([]);
    expect(existsSync(value.target)).toBe(true);
});

test("confirmed cleanup writes a manifest and removes only the validated retired directory", async () => {
    const value = fixture();
    const canonical = join(value.toolsHome, ".genesis-tools", "claude-history");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "index.db"), "protected");
    const result = retireNativeCache({
        toolsHome: value.toolsHome,
        manifestDirectory: value.manifestDirectory,
        confirmDelete: true,
        processInspector: () => [],
    });

    expect(result.deleted).toBe(true);
    expect(result.manifest && existsSync(result.manifest)).toBe(true);
    expect(existsSync(value.target)).toBe(false);
    await expect(Bun.file(join(canonical, "index.db")).text()).resolves.toBe("protected");
});

test("cleanup refuses an unfamiliar schema or file", () => {
    const value = fixture();
    const deletion = refusedRemoval();
    writeFileSync(join(value.target, "unexpected"), "stop");
    expect(inspectNativeCache(value.toolsHome, () => []).schemaMatches).toBe(false);
    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            confirmDelete: true,
            processInspector: () => [],
            remove: deletion.remove,
        })
    ).toThrow("do not match");
    expect(deletion.paths).toEqual([]);
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup refuses unknown tables inside an otherwise recognized retired database", () => {
    const value = fixture();
    const deletion = refusedRemoval();
    const database = new Database(join(value.target, "index.db"));
    database.exec("CREATE TABLE protected_notes(id TEXT)");
    database.close();
    expect(inspectNativeCache(value.toolsHome, () => []).schemaMatches).toBe(false);
    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            confirmDelete: true,
            processInspector: () => [],
            remove: deletion.remove,
        })
    ).toThrow("do not match");
    expect(deletion.paths).toEqual([]);
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup refuses handles opened during quarantine and restores the directory", () => {
    const value = fixture();
    const deletion = refusedRemoval();
    let calls = 0;
    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            confirmDelete: true,
            processInspector: () => (++calls === 1 ? [] : [{ pid: 123, command: "fixture-writer" }]),
            remove: deletion.remove,
        })
    ).toThrow("became active");
    expect(deletion.paths).toEqual([]);
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup rejects a manifest location that would be deleted with the cache", () => {
    const value = fixture();
    const deletion = refusedRemoval();
    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            confirmDelete: true,
            manifestDirectory: join(value.target, "manifests"),
            processInspector: () => [],
            remove: deletion.remove,
        })
    ).toThrow("must be outside");
    expect(deletion.paths).toEqual([]);
    expect(existsSync(value.target)).toBe(true);
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("retirement defaults to a read-only report", () => {
    const value = fixture();
    const before = Bun.file(join(value.target, "index.db")).size;
    const result = retireNativeCache({
        toolsHome: value.toolsHome,
        manifestDirectory: value.manifestDirectory,
        confirmDelete: false,
        processInspector: () => [],
    });

    expect(result.deleted).toBe(false);
    expect(result.report).toMatchObject({ exists: true, schemaMatches: true, bytes: before });
    expect(existsSync(value.target)).toBe(true);
    expect(existsSync(value.manifestDirectory)).toBe(false);
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
    writeFileSync(join(value.target, "unexpected"), "stop");
    expect(inspectNativeCache(value.toolsHome, () => []).schemaMatches).toBe(false);
    expect(() =>
        retireNativeCache({ toolsHome: value.toolsHome, confirmDelete: true, processInspector: () => [] })
    ).toThrow("do not match");
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup refuses unknown tables inside an otherwise recognized retired database", () => {
    const value = fixture();
    const database = new Database(join(value.target, "index.db"));
    database.exec("CREATE TABLE protected_notes(id TEXT)");
    database.close();
    expect(inspectNativeCache(value.toolsHome, () => []).schemaMatches).toBe(false);
    expect(() =>
        retireNativeCache({ toolsHome: value.toolsHome, confirmDelete: true, processInspector: () => [] })
    ).toThrow("do not match");
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup refuses handles opened during quarantine and restores the directory", () => {
    const value = fixture();
    let calls = 0;
    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            confirmDelete: true,
            processInspector: () => (++calls === 1 ? [] : [{ pid: 123, command: "fixture-writer" }]),
        })
    ).toThrow("became active");
    expect(existsSync(value.target)).toBe(true);
});

test("cleanup rejects a manifest location that would be deleted with the cache", () => {
    const value = fixture();
    expect(() =>
        retireNativeCache({
            toolsHome: value.toolsHome,
            confirmDelete: true,
            manifestDirectory: join(value.target, "manifests"),
            processInspector: () => [],
        })
    ).toThrow("must be outside");
    expect(existsSync(value.target)).toBe(true);
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { BOOTSTRAP_DDL } from "./db";
import type { BoardsDb } from "./db-types";
import {
    getSet,
    getSetFile,
    isReservedKey,
    KEY_RE,
    listProjects,
    listSets,
    mintKey,
    NameConflictError,
    NotFoundError,
    patchSet,
    setRefOf,
    slugifyBranch,
    syncSet,
} from "./sets-store";

function makeTestDb(): DatabaseClient<BoardsDb> {
    return createKyselyClient<BoardsDb>({ path: ":memory:", bootstrap: BOOTSTRAP_DDL, pragmas: { foreignKeys: true } });
}

function file(path: string, text: string) {
    return { path, data: new TextEncoder().encode(text) };
}

describe("sets-store", () => {
    let db: DatabaseClient<BoardsDb>;

    beforeEach(() => {
        const dir = mkdtempSync(join(tmpdir(), "boards-sets-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
    });

    it("slugifyBranch lowercases, collapses non-alnum runs, trims edges, caps length", () => {
        expect(slugifyBranch("Feature/Foo Bar")).toBe("feature-foo-bar");
        expect(slugifyBranch("--weird--")).toBe("weird");
        expect(slugifyBranch("")).toBe("main");
    });

    it("isReservedKey rejects pure-numeric, 'latest', and .zip names", () => {
        expect(isReservedKey("123")).toBe(true);
        expect(isReservedKey("latest")).toBe(true);
        expect(isReservedKey("foo.zip")).toBe(true);
        expect(isReservedKey("s-20260101-1200")).toBe(false);
    });

    it("setRefOf joins project/branch/key", () => {
        expect(setRefOf({ project: "p", branch: "main", key: "s1" })).toBe("p/main/s1");
    });

    it("first push mints version 1 and reports created:true", async () => {
        const result = await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [file("a.txt", "A"), file("b.txt", "B")],
        });
        expect(result.created).toBe(true);
        expect(result.set.version).toBe(1);
        expect(result.set.fileCount).toBe(2);
        expect(result.set.branch).toBe("main");
    });

    it("re-pushing the same key keeps its version and replaces all file rows", async () => {
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [file("a.txt", "A"), file("b.txt", "B")],
        });
        const second = await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [file("only.txt", "ONLY")],
        });
        expect(second.created).toBe(false);
        expect(second.set.version).toBe(1);
        expect(second.set.fileCount).toBe(1);

        const detail = await getSet(db, "proj", "main", "s1");
        expect(detail.files.length).toBe(1);
        expect(detail.files[0].path).toBe("only.txt");
    });

    it("a second key on the same project+branch mints version 2", async () => {
        await syncSet(db, { project: "proj", branchRaw: "main", key: "s1", entries: [file("a.txt", "A")] });
        const second = await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s2",
            entries: [file("b.txt", "B")],
        });
        expect(second.set.version).toBe(2);
    });

    it("manifest.json meta lands on matching file rows and is not itself a file row", async () => {
        const manifest = SafeJSON.stringify({
            journey: { name: "Onboarding" },
            shots: [{ file: "a.png", route: "/home", action: "click button" }],
        });
        await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [file("manifest.json", manifest), file("a.png", "fake-png-bytes")],
        });
        const detail = await getSet(db, "proj", "main", "s1");
        expect(detail.files.length).toBe(1);
        expect(detail.files[0].path).toBe("a.png");
        expect(detail.files[0].meta).toEqual({ route: "/home", action: "click button" });
    });

    it("selector grammar: version, latest, key, and name (after patchSet)", async () => {
        const first = await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [file("a.txt", "A")],
        });
        const second = await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s2",
            entries: [file("b.txt", "B")],
        });

        expect((await getSet(db, "proj", "main", "1")).id).toBe(first.set.id);
        expect((await getSet(db, "proj", "main", "latest")).id).toBe(second.set.id);
        expect((await getSet(db, "proj", "main", "s1")).id).toBe(first.set.id);

        const patched = await patchSet(db, "proj", "main", "s1", { name: "my-cool-name" });
        expect(patched.name).toBe("my-cool-name");
        expect((await getSet(db, "proj", "main", "my-cool-name")).id).toBe(first.set.id);
    });

    it("patchSet rejects numeric names and duplicate names", async () => {
        await syncSet(db, { project: "proj", branchRaw: "main", key: "s1", entries: [file("a.txt", "A")] });
        await syncSet(db, { project: "proj", branchRaw: "main", key: "s2", entries: [file("b.txt", "B")] });

        await expect(patchSet(db, "proj", "main", "s1", { name: "123" })).rejects.toBeInstanceOf(NameConflictError);

        await patchSet(db, "proj", "main", "s1", { name: "taken" });
        await expect(patchSet(db, "proj", "main", "s2", { name: "taken" })).rejects.toBeInstanceOf(NameConflictError);
    });

    it("getSet throws NotFoundError for an unknown selector", async () => {
        await expect(getSet(db, "proj", "main", "nope")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("mintKey produces the s-YYYYMMDD-HHMM shape", async () => {
        const key = await mintKey(db, "proj", "main");
        expect(key).toMatch(/^s-\d{8}-\d{4}$/);
    });

    it("mintKey appends -2, -3 on collision", async () => {
        const key1 = await mintKey(db, "proj", "main");
        await syncSet(db, { project: "proj", branchRaw: "main", key: key1, entries: [file("a.txt", "A")] });
        const key2 = await mintKey(db, "proj", "main");
        expect(key2).toBe(`${key1}-2`);
    });

    it("listSets returns newest first; listProjects aggregates branches/sets", async () => {
        await syncSet(db, { project: "proj", branchRaw: "main", key: "s1", entries: [file("a.txt", "A")] });
        await syncSet(db, { project: "proj", branchRaw: "feature/x", key: "s1", entries: [file("a.txt", "A")] });

        const sets = await listSets(db, "proj");
        expect(sets.length).toBe(2);

        const projects = await listProjects(db);
        const proj = projects.find((p) => p.project === "proj");
        expect(proj?.sets).toBe(2);
        expect(proj?.branches).toBe(2);
    });

    it("getSetFile resolves a single file by path", async () => {
        const result = await syncSet(db, {
            project: "proj",
            branchRaw: "main",
            key: "s1",
            entries: [file("a.txt", "A")],
        });
        const detail = await getSet(db, "proj", "main", "s1");
        const setId = detail.id;
        expect(result.set.id).toBe(setId);
        const f = await getSetFile(db, setId, "a.txt");
        expect(f?.path).toBe("a.txt");
        expect(await getSetFile(db, setId, "missing.txt")).toBeNull();
    });

    it("KEY_RE accepts alnum/dot/dash/underscore up to 64 chars", () => {
        expect(KEY_RE.test("s-20260101-1200")).toBe(true);
        expect(KEY_RE.test("has space")).toBe(false);
    });
});

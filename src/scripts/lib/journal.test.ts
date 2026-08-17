import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    filterScripts,
    journalHealth,
    mutateEntry,
    readJournal,
    recordRun,
    renameScript,
    type ScriptEntry,
    scriptPaths,
    trashEntry,
    upsertEntry,
} from "./journal.ts";

let root: string;

function entry(partial: Partial<ScriptEntry> & { name: string }): ScriptEntry {
    return {
        file: scriptPaths(partial.name, root).file,
        description: undefined,
        imports: [],
        tools: [],
        servers: [],
        tags: [],
        createdFrom: "/somewhere",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        runs: 0,
        ...partial,
    };
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scripts-journal-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("journal round-trip", () => {
    it("upsert then read returns the entry; missing journal reads empty", async () => {
        expect((await readJournal(root)).scripts).toEqual([]);

        await upsertEntry(entry({ name: "alpha" }), root);
        await upsertEntry(entry({ name: "alpha", description: "second write wins" }), root);

        const journal = await readJournal(root);
        expect(journal.scripts).toHaveLength(1);
        expect(journal.scripts[0]?.description).toBe("second write wins");
    });

    it("concurrent read-modify-writes are serialised by the journal lock", async () => {
        await Promise.all(Array.from({ length: 8 }, (_, i) => upsertEntry(entry({ name: `script${i}` }), root)));

        expect((await readJournal(root)).scripts).toHaveLength(8);

        await Promise.all(
            Array.from({ length: 5 }, () =>
                recordRun("script0", { at: "t", cwd: "/x", exitCode: 0, durationMs: 1 }, root)
            )
        );

        expect((await readJournal(root)).scripts.find((s) => s.name === "script0")?.runs).toBe(5);
    });

    it("mutateEntry preserves concurrent run-counter bumps instead of clobbering them", async () => {
        await upsertEntry(entry({ name: "target" }), root);

        await Promise.all([
            recordRun("target", { at: "t", cwd: "/x", exitCode: 0, durationMs: 1 }, root),
            recordRun("target", { at: "t", cwd: "/x", exitCode: 0, durationMs: 1 }, root),
            mutateEntry(
                "target",
                (e) => {
                    e.tags = ["tagged"];
                },
                root
            ),
        ]);

        const final = (await readJournal(root)).scripts[0];
        expect(final?.runs).toBe(2);
        expect(final?.tags).toEqual(["tagged"]);

        expect(await mutateEntry("missing", () => {}, root)).toBe(false);
    });

    it("a no-op mutation does not write the journal at all", async () => {
        await recordRun("nobody-home", { at: "t", cwd: "/x", exitCode: 0, durationMs: 1 }, root);

        expect(await Bun.file(join(root, "persisted", "_journal.json")).exists()).toBe(false);
    });

    it("journalHealth inspects without writing the rescue backup", async () => {
        expect(await journalHealth(root)).toBe("missing");

        await Bun.write(join(root, "persisted", "_journal.json"), "{ broken");
        expect(await journalHealth(root)).toBe("corrupt");

        const files = await readdir(join(root, "persisted"));
        expect(files.filter((f) => f.startsWith("_journal.corrupt-"))).toEqual([]);
    });

    it("a corrupt journal is backed up before being treated as empty", async () => {
        const journalFile = join(root, "persisted", "_journal.json");
        await Bun.write(journalFile, "{ not json at all");

        expect((await readJournal(root)).scripts).toEqual([]);

        const backups = (await readdir(join(root, "persisted"))).filter((f) => f.startsWith("_journal.corrupt-"));
        expect(backups).toHaveLength(1);
        expect(await Bun.file(join(root, "persisted", backups[0] as string)).text()).toBe("{ not json at all");

        // The next write may rebuild the journal, but the backup survives it.
        await upsertEntry(entry({ name: "fresh" }), root);
        expect(await Bun.file(join(root, "persisted", backups[0] as string)).exists()).toBe(true);
    });
});

describe("gating", () => {
    const gated = () => entry({ name: "gated", gateDir: "/repo/project" });
    const open = () => entry({ name: "open" });

    it("hides gated scripts outside their tree, shows them inside and below", () => {
        const scripts = [gated(), open()];

        expect(filterScripts(scripts, { visibleFrom: "/elsewhere" }).map((s) => s.name)).toEqual(["open"]);
        expect(filterScripts(scripts, { visibleFrom: "/repo/project" }).map((s) => s.name)).toEqual(["gated", "open"]);
        expect(filterScripts(scripts, { visibleFrom: "/repo/project/sub/dir" }).map((s) => s.name)).toEqual([
            "gated",
            "open",
        ]);
    });

    it("a sibling directory sharing the prefix is NOT inside the gate", () => {
        expect(filterScripts([gated()], { visibleFrom: "/repo/project-two" })).toEqual([]);
    });

    it("--all reveals gated scripts everywhere", () => {
        expect(filterScripts([gated()], { visibleFrom: "/elsewhere", all: true }).map((s) => s.name)).toEqual([
            "gated",
        ]);
    });
});

describe("filters", () => {
    const scripts = [
        entry({
            name: "one",
            tags: ["triage", "col"],
            project: "GenesisTools",
            servers: ["gh_grep"],
            tools: ["gh_grep.searchGitHub"],
        }),
        entry({ name: "two", tags: ["demo"], project: "Other", servers: ["figma"], createdFrom: "/repo/other" }),
    ];

    it("tag filter requires every tag, case-insensitive", () => {
        expect(filterScripts(scripts, { tag: ["TRIAGE", "col"] }).map((s) => s.name)).toEqual(["one"]);
        expect(filterScripts(scripts, { tag: ["triage", "missing"] })).toEqual([]);
    });

    it("project, server, cwd and grep narrow the list", () => {
        expect(filterScripts(scripts, { project: "other" }).map((s) => s.name)).toEqual(["two"]);
        expect(filterScripts(scripts, { server: "GH_GREP" }).map((s) => s.name)).toEqual(["one"]);
        expect(filterScripts(scripts, { cwd: "/repo" }).map((s) => s.name)).toEqual(["two"]);
        expect(filterScripts(scripts, { grep: "searchgithub" }).map((s) => s.name)).toEqual(["one"]);
    });

    it("cwd is a path boundary, not a string prefix", () => {
        const sibling = entry({ name: "sibling", createdFrom: "/repo2/deep" });
        expect(filterScripts([...scripts, sibling], { cwd: "/repo" }).map((s) => s.name)).toEqual(["two"]);
    });
});

describe("rename", () => {
    it("moves the directory, re-stems named files, rewrites imports and the journal", async () => {
        const paths = scriptPaths("before", root);
        await Bun.write(paths.file, 'import * as T from "./before.tools.ts";\n// tools scripts run before\n');
        await Bun.write(paths.toolsFile, "export const TOOLS = {};\n");
        await Bun.write(join(paths.dir, "before.state.json"), "{}\n");
        await upsertEntry(entry({ name: "before" }), root);

        const result = await renameScript("before", "after", root);

        expect(result.moved).toContain("before.ts → after.ts");
        expect(result.moved).toContain("before.state.json → after.state.json");

        const renamed = scriptPaths("after", root);
        const body = await Bun.file(renamed.file).text();
        expect(body).toContain('"./after.tools.ts"');
        expect(body).toContain("scripts run after");

        const journal = await readJournal(root);
        expect(journal.scripts[0]?.name).toBe("after");
        expect(journal.scripts[0]?.file).toBe(renamed.file);
    });

    it("refuses an invalid target name and a taken target name", async () => {
        const paths = scriptPaths("src", root);
        await Bun.write(paths.file, "// x\n");

        await expect(renameScript("src", "1bad", root)).rejects.toThrow(/Invalid script name/);

        await Bun.write(scriptPaths("taken", root).file, "// y\n");
        await expect(renameScript("src", "taken", root)).rejects.toThrow(/already exists/);
    });
});

describe("trash", () => {
    it("moves the whole directory into trash/ and drops the journal entry", async () => {
        const paths = scriptPaths("doomed", root);
        await Bun.write(paths.file, "// body\n");
        await Bun.write(join(paths.dir, "out.txt"), "sidecar\n");
        await upsertEntry(entry({ name: "doomed" }), root);

        const moved = await trashEntry("doomed", root);

        expect(moved).toBeDefined();
        expect(await Bun.file(paths.file).exists()).toBe(false);
        expect(await Bun.file(join(moved?.to ?? "", "doomed.ts")).exists()).toBe(true);
        expect(await Bun.file(join(moved?.to ?? "", "out.txt")).exists()).toBe(true);
        expect((await readJournal(root)).scripts).toEqual([]);
    });

    it("returns undefined for unknown scripts", async () => {
        expect(await trashEntry("nope", root)).toBeUndefined();
    });

    it("an already-missing directory drops the stale entry and reports moved: false", async () => {
        await upsertEntry(entry({ name: "ghost" }), root);

        const result = await trashEntry("ghost", root);

        expect(result?.moved).toBe(false);
        expect((await readJournal(root)).scripts).toEqual([]);
    });
});

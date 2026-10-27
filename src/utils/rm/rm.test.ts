import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    renameSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertInsideTrash,
    BUILTIN_PRESETS,
    confirmByPerson,
    createRmRequest,
    defaultRmConfig,
    drainDue,
    effectiveConfig,
    evaluateTarget,
    filterRmLedger,
    findNestedRepos,
    listBatches,
    listRmRequests,
    loadRmRequest,
    moveAside,
    moveToTrash,
    parseRmConfig,
    pendingAsideDirs,
    pendingAsideFor,
    planRemoval,
    presetsFor,
    probeGit,
    RM_REQUEST_TTL_MS,
    type RmCaller,
    type RmConfig,
    type RmLedgerEntry,
    type RmRuleContext,
    resolveTarget,
    restoreBatch,
    returnAside,
    runDrainer,
    saveRmRequest,
    scanPresets,
    sweepOrphans,
    type TrashPaths,
    totalRmLedger,
    trashItemName,
} from "./index";

const AGENT: RmCaller = { agent: "claude-code", sessionId: "sess-1111", isInAgent: true };

let base: string;
let config: RmConfig;
let trashPaths: TrashPaths;

function dir(...parts: string[]): string {
    const path = join(base, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
}

function file(path: string, content = "x"): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
}

function git(cwd: string, ...args: string[]): void {
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });

    if (proc.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    }
}

function ctx(overrides: Partial<RmRuleContext> = {}): RmRuleContext {
    return {
        config,
        caller: AGENT,
        cwd: dir("cwd"),
        home: dir("home"),
        presets: BUILTIN_PRESETS,
        ownFiles: new Set(),
        scratchRoots: [dir("cc")],
        asidePending: () => null,
        git: probeGit,
        nestedRepos: (target) => findNestedRepos(target),
        ...overrides,
    };
}

function verdictOf(path: string, context = ctx()): { kind: string; rule: string } {
    const { kind, rule } = evaluateTarget(resolveTarget(path, context.cwd), context);
    return { kind, rule };
}

beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gt-rm-")));
    config = { ...defaultRmConfig(), trashRoot: join(base, "GenesisTools", "rm") };
    trashPaths = { batchesDir: join(base, "state", "batches"), lockPath: join(base, "state", "drainer.lock") };
});

afterAll(async () => {
    await drainDue({ config, paths: trashPaths, force: true });
});

describe("hard deny", () => {
    test("refuses the root, home, the cwd and its ancestors, home's direct children, the trash and missing paths", () => {
        const c = ctx();

        expect(verdictOf("/", c)).toEqual({ kind: "deny", rule: "hard-deny" });
        expect(verdictOf(c.home, c).kind).toBe("deny");
        expect(verdictOf(dir("home", "Documents"), c).kind).toBe("deny");
        expect(verdictOf(c.cwd, c).kind).toBe("deny");
        expect(verdictOf(base, c).kind).toBe("deny");
        expect(verdictOf(dir("GenesisTools", "rm"), c).kind).toBe("deny");
        expect(verdictOf(join(base, "nope"), c).kind).toBe("deny");
    });

    test("refuses a configured protected path and any folder that holds one", () => {
        const guarded = dir("keep", "precious");
        const c = ctx({ config: { ...config, protect: [guarded] } });

        expect(verdictOf(guarded, c).kind).toBe("deny");
        expect(verdictOf(dir("keep"), c).kind).toBe("deny");
    });
});

describe("presets", () => {
    test("allow a preset folder only next to its marker file", () => {
        const app = dir("work", "app");
        file(join(app, "package.json"), "{}");
        dir("work", "app", "node_modules", "left-pad");
        dir("work", "loose", "node_modules");
        file(join(app, "Package.swift"));
        dir("work", "app", ".build");

        expect(verdictOf(join(app, "node_modules"))).toEqual({ kind: "allow", rule: "preset" });
        expect(verdictOf(join(app, ".build"))).toEqual({ kind: "allow", rule: "preset" });
        expect(verdictOf(join(base, "work", "loose", "node_modules"))).toEqual({ kind: "ask", rule: "default" });
    });

    test("scanning finds matches without entering them, and node_modules/.cache", () => {
        const repo = dir("scan");
        file(join(repo, "package.json"), "{}");
        dir("scan", "dist");
        dir("scan", "node_modules", "jest", "build");
        dir("scan", "node_modules", ".cache");
        file(join(repo, "pkg", "package.json"), "{}");
        dir("scan", "pkg", "build");

        const scan = (presets: typeof BUILTIN_PRESETS) =>
            scanPresets(repo, presets)
                .map((m) => `${m.preset.id}:${m.path.slice(repo.length + 1)}`)
                .sort();

        // node_modules itself matches, so its .cache and jest's own build/ go with it and are not listed.
        expect(scan(BUILTIN_PRESETS)).toEqual(["js-build:dist", "js-build:pkg/build", "node_modules:node_modules"]);
        expect(scan(BUILTIN_PRESETS.filter((p) => p.id !== "node_modules"))).toEqual([
            "js-build:dist",
            "js-build:pkg/build",
            "node-cache:node_modules/.cache",
        ]);
    });
});

describe("git", () => {
    let repo: string;

    beforeAll(() => {
        repo = dir("repo");
        git(repo, "init", "-q");
        file(join(repo, "package.json"), "{}");
        file(join(repo, ".gitignore"), "dist/\n");
        file(join(repo, "src", "a.ts"), "export {};\n");
        git(repo, "add", ".");
        git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
        file(join(repo, "dist", "out.js"));
        file(join(repo, "notes.md"));
    });

    test("tracked files need the user; an ignored preset folder does not", () => {
        expect(verdictOf(join(repo, "src"))).toEqual({ kind: "ask", rule: "git-tracked" });
        expect(verdictOf(join(repo, "dist"))).toEqual({ kind: "allow", rule: "preset" });
    });

    test("an untracked file needs the user unless this session wrote it", () => {
        const notes = join(repo, "notes.md");

        expect(verdictOf(notes)).toEqual({ kind: "ask", rule: "git-untracked" });
        expect(verdictOf(notes, ctx({ ownFiles: new Set([notes]) }))).toEqual({ kind: "allow", rule: "own-files" });
    });

    test("a linked worktree is refused, and a clone with uncommitted work needs the user", () => {
        const linked = join(base, "linked-wt");
        git(repo, "worktree", "add", "-q", "--detach", linked);
        file(join(base, "clone-parent", "keep.txt"));
        git(repo, "clone", "-q", repo, join(base, "clone-parent", "clone"));
        file(join(base, "clone-parent", "clone", "new.txt"));

        expect(verdictOf(linked)).toEqual({ kind: "deny", rule: "registered-worktree" });
        expect(verdictOf(join(base, "clone-parent", "clone"))).toEqual({ kind: "ask", rule: "unsaved-clone" });
        expect(verdictOf(join(base, "clone-parent"))).toEqual({ kind: "ask", rule: "nested-repos" });
    });
});

describe("session scratch and roots", () => {
    test("the caller's own scratch folder is allowed, another session's is not", () => {
        const c = ctx();
        const mine = dir("cc", "proj", "sess-1111", "probe");
        const theirs = dir("cc", "proj", "sess-2222", "probe");

        expect(verdictOf(mine, c)).toEqual({ kind: "allow", rule: "session-scratch" });
        expect(verdictOf(theirs, c)).toEqual({ kind: "ask", rule: "default" });
    });

    test("a trusted root allows what is inside it, never the root itself", () => {
        const root = dir("trusted");
        const c = ctx({ config: { ...config, roots: [{ path: root, addedAt: "", via: "cli" }] } });

        expect(verdictOf(dir("trusted", "x"), c)).toEqual({ kind: "allow", rule: "root" });
        expect(verdictOf(root, c)).toEqual({ kind: "ask", rule: "default" });
    });

    test("a path inside another input is dropped from the plan", () => {
        const outer = dir("cc", "proj", "sess-1111", "outer");
        const plan = planRemoval([outer, join(outer, "inner"), outer], ctx());

        expect(plan.map((item) => item.target.path)).toEqual([outer]);
    });
});

describe("trash", () => {
    test("moves aside, restores, then drains only inside the trash", async () => {
        const target = resolveTarget(file(join(dir("t1"), "a.txt"), "hello"), base);
        const batch = moveToTrash([{ target, rule: "test" }], {
            config,
            caller: AGENT,
            graceMinutes: 60,
            paths: trashPaths,
        });

        expect(batch?.items).toHaveLength(1);
        expect(existsSync(target.path)).toBe(false);
        expect(listBatches(trashPaths).map((b) => b.id)).toContain(batch?.id ?? "");

        const restored = restoreBatch(batch?.id ?? "", { config, paths: trashPaths });

        expect(restored.restored).toEqual([target.path]);
        expect(existsSync(target.path)).toBe(true);

        const again = moveToTrash([{ target, rule: "test" }], {
            config,
            caller: AGENT,
            graceMinutes: 60,
            paths: trashPaths,
        });
        const early = await drainDue({ config, paths: trashPaths });

        expect(early.batches).toBe(0);
        expect(existsSync(again?.items[0]?.stored ?? "")).toBe(true);

        const forced = await drainDue({ config, paths: trashPaths, force: true });

        expect(forced.items).toBeGreaterThanOrEqual(1);
        expect(existsSync(again?.items[0]?.stored ?? "x")).toBe(false);
        expect(listBatches(trashPaths)).toHaveLength(0);
    });

    test("assertInsideTrash refuses anything outside the trash or above item depth", () => {
        expect(() => assertInsideTrash(join(base, "repo"), config, "item")).toThrow(/not inside a trash/);
        expect(() => assertInsideTrash(join(config.trashRoot, "batch"), config, "item")).toThrow(/not inside a trash/);
        expect(() => assertInsideTrash(`${config.trashRoot}/../x/y`, config, "batch")).toThrow(/plain path/);
        expect(() =>
            assertInsideTrash(join(config.trashRoot, "b", "i"), { ...config, trashRoot: base }, "item")
        ).toThrow(/no GenesisTools folder/);
        expect(() => assertInsideTrash(join(config.trashRoot, "b", "i"), config, "item")).not.toThrow();
    });

    test("an unrecorded old trash folder is swept, and a dead process's claim is given back", async () => {
        const orphan = join(config.trashRoot, "orphan-batch");
        file(join(orphan, "0-x"));
        utimesSync(orphan, new Date(0), new Date(0));
        mkdirSync(trashPaths.batchesDir, { recursive: true });
        writeFileSync(join(trashPaths.batchesDir, "dead.json.draining-999999"), "{}");

        const swept = await sweepOrphans({ config, paths: trashPaths });

        expect(swept.batches).toBe(1);
        expect(existsSync(orphan)).toBe(false);
        expect(readdirSync(trashPaths.batchesDir)).toContain("dead.json");
        renameSync(join(trashPaths.batchesDir, "dead.json"), join(base, "dead.json.kept"));
    });

    test("the drainer waits for the grace period, then drains and exits", async () => {
        const target = resolveTarget(file(join(dir("t2"), "b.txt")), base);
        moveToTrash([{ target, rule: "test" }], { config, caller: null, graceMinutes: 5, paths: trashPaths });
        let clock = Date.now();
        const slept: number[] = [];

        const result = await runDrainer({
            config,
            paths: trashPaths,
            now: () => new Date(clock),
            sleep: async (ms) => {
                slept.push(ms);
                clock += ms;
            },
        });

        expect(slept).toHaveLength(1);
        expect(slept[0]).toBeGreaterThan(4 * 60_000);
        expect(result.items).toBe(1);
        expect(listBatches(trashPaths)).toHaveLength(0);
    });

    test("a drainer started while another sleeps still drains a due batch at once", async () => {
        const target = resolveTarget(file(join(dir("t3"), "c.txt")), base);
        moveToTrash([{ target, rule: "test" }], { config, caller: null, graceMinutes: 0, paths: trashPaths });
        mkdirSync(join(trashPaths.lockPath, ".."), { recursive: true });
        writeFileSync(trashPaths.lockPath, String(process.pid));
        let slept = 0;

        const result = await runDrainer({
            config,
            paths: trashPaths,
            sleep: async () => {
                slept++;
            },
        });
        unlinkSync(trashPaths.lockPath);

        expect(result.items).toBe(1);
        expect(slept).toBe(0);
        expect(listBatches(trashPaths)).toHaveLength(0);
    });

    test("a stored name stays short for a very long path and differs per parent", () => {
        const deep = `/x/${"a".repeat(240)}/node_modules`;

        expect(trashItemName(0, deep).length).toBeLessThan(120);
        expect(trashItemName(0, "/a/node_modules")).not.toBe(trashItemName(0, "/b/node_modules"));
    });
});

describe("requests and approval", () => {
    test("a request is listed while pending and reads as expired after its TTL", () => {
        const requestsDir = dir("requests");
        const request = createRmRequest(
            { kind: "delete", caller: AGENT, cwd: base, reason: "cleanup", targets: [] },
            requestsDir
        );

        expect(listRmRequests({ dir: requestsDir }).map((r) => r.id)).toEqual([request.id]);
        expect(loadRmRequest(request.id, requestsDir, new Date(Date.now() + RM_REQUEST_TTL_MS + 1))?.status).toBe(
            "expired"
        );
        expect(loadRmRequest("../etc", requestsDir)).toBeNull();
    });

    test("an agent never gets the typed prompt, even with a terminal; the dialog asks instead", async () => {
        const calls: string[] = [];
        const deps = {
            interactive: () => true,
            platform: "darwin" as const,
            typed: async () => {
                calls.push("typed");
                return true;
            },
            dialog: () => {
                calls.push("dialog");
                return false;
            },
        };
        const prompt = { title: "t", lines: [], code: "abc" };

        expect((await confirmByPerson({ ...prompt, caller: AGENT }, deps)).via).toBe("dialog");
        expect((await confirmByPerson({ ...prompt, caller: { ...AGENT, isInAgent: false } }, deps)).approved).toBe(
            true
        );
        expect(calls).toEqual(["dialog", "typed"]);
        expect((await confirmByPerson({ ...prompt, caller: AGENT }, { ...deps, platform: "linux" })).via).toBe("none");
    });
});

describe("config", () => {
    test("a trash root without a GenesisTools folder falls back to the default", () => {
        expect(parseRmConfig({ trashRoot: "/Users/someone" }).trashRoot).toBe(defaultRmConfig().trashRoot);
        expect(parseRmConfig({ trashRoot: "/Volumes/x/GenesisTools/rm" }).trashRoot).toBe("/Volumes/x/GenesisTools/rm");
        expect(parseRmConfig({ grace: { otherMinutes: -5 } }).grace.otherMinutes).toBe(60);
    });
});

describe("aside", () => {
    test("moves a path aside, the pending batch is refused to everyone, deny puts it back", () => {
        const requestsDir = dir("aside-requests");
        const src = file(join(dir("aside-src"), "draft.md"), "work");
        const target = resolveTarget(src, base);
        const verdict = { kind: "ask" as const, rule: "git-tracked", reason: "tracked" };
        const aside = moveAside([{ target, verdict }], AGENT, "b1", dir("cc", "proj", "sess-1111", "rm-aside"));

        expect(aside.moved).toHaveLength(1);
        expect(existsSync(src)).toBe(false);
        expect(aside.moved[0]?.bytes).toBeGreaterThan(0);

        const request = createRmRequest(
            { kind: "delete", caller: AGENT, cwd: base, reason: null, targets: aside.moved, asideDir: aside.dir },
            requestsDir
        );
        const pending = pendingAsideDirs(requestsDir);
        const c = ctx({ asidePending: (t) => pendingAsideFor(t.canonical, pending) });

        // The aside folder sits in the session's scratch, yet the pending request wins over the scratch rule.
        expect(verdictOf(aside.dir, c)).toEqual({ kind: "deny", rule: "aside-pending" });
        expect(verdictOf(dir("cc", "proj", "sess-1111"), c)).toEqual({ kind: "deny", rule: "aside-pending" });
        expect(verdictOf(aside.moved[0]?.stored ?? "", c)).toEqual({ kind: "deny", rule: "aside-pending" });
        expect(loadRmRequest(request.id, requestsDir, new Date(Date.now() + RM_REQUEST_TTL_MS * 3))?.status).toBe(
            "pending"
        );

        const back = returnAside(aside.moved, AGENT, request.id);

        expect(back.returned).toEqual([src]);
        expect(existsSync(src)).toBe(true);
        saveRmRequest({ ...request, status: "denied" }, requestsDir);
        expect(pendingAsideDirs(requestsDir)).toEqual([]);
    });
});

describe("profiles", () => {
    test("matching profiles apply in order: scalars replace, lists add", () => {
        const withProfiles: RmConfig = {
            ...config,
            protect: ["/base"],
            profiles: [
                { name: "codex", match: { agent: "codex" }, askAction: "request", protect: ["/codex"] },
                { name: "claude", match: { agent: "claude-code" }, askAction: "request", protect: ["/claude"] },
                { name: "one-session", match: { session: "sess-11" }, askAction: "aside", allowOwnFiles: false },
                { name: "people", match: { agent: "person" }, allowSessionScratch: false },
            ],
        };
        const agent = effectiveConfig(withProfiles, AGENT, base);
        const person = effectiveConfig(withProfiles, { ...AGENT, isInAgent: false, sessionId: null }, base);

        expect(agent.applied).toEqual(["claude", "one-session"]);
        expect(agent.config.askAction).toBe("aside");
        expect(agent.config.allowOwnFiles).toBe(false);
        expect(agent.config.protect).toEqual(["/base", "/claude"]);
        expect(person.applied).toEqual(["person", "people"]);
        expect(person.config.allowSessionScratch).toBe(false);
    });

    test("a profile that turns the scratch rule off makes the session's scratch ask", () => {
        const mine = dir("cc", "proj", "sess-1111", "probe2");
        const c = ctx({ config: { ...config, allowSessionScratch: false } });

        expect(verdictOf(mine, c)).toEqual({ kind: "ask", rule: "default" });
    });
});

describe("audit log", () => {
    test("totals moved, aside and reclaimed bytes per agent, and filters by session", () => {
        const codex: RmCaller = { agent: "codex", sessionId: "cdx-9", isInAgent: true };
        const at = new Date().toISOString();
        const entries: RmLedgerEntry[] = [
            { at, action: "move", bytes: 100, caller: AGENT },
            { at, action: "drain", bytes: 100, caller: AGENT },
            { at, action: "aside", bytes: 40, caller: codex },
            { at, action: "refuse", caller: codex },
            { at: "2020-01-01T00:00:00.000Z", action: "move", bytes: 5, caller: codex },
        ];
        const totals = totalRmLedger(filterRmLedger(entries, { since: new Date(Date.now() - 60_000) }), "agent");

        expect(totals).toEqual([
            { key: "claude-code", moved: 100, aside: 0, reclaimed: 100, items: 1, refused: 0, requests: 0 },
            { key: "codex", moved: 0, aside: 40, reclaimed: 0, items: 1, refused: 1, requests: 0 },
        ]);
        expect(filterRmLedger(entries, { session: "cdx" })).toHaveLength(3);
    });
});

describe("defaults", () => {
    const codex: RmCaller = { agent: "codex", sessionId: "cdx-1", isInAgent: true };
    const person: RmCaller = { agent: "unknown", sessionId: null, isInAgent: false };

    test("built-in profiles: a person leaves paths in place, codex and grok get 4 h to undo, claude stays on aside", () => {
        expect(effectiveConfig(config, person, base).config.askAction).toBe("request");
        expect(effectiveConfig(config, codex, base).config.grace.otherMinutes).toBe(240);
        expect(effectiveConfig(config, { ...codex, agent: "grok" }, base).applied).toEqual(["workers"]);

        const claude = effectiveConfig(config, AGENT, base);

        expect(claude.applied).toEqual([]);
        expect(claude.config.askAction).toBe("aside");
        expect(claude.config.grace.otherMinutes).toBe(60);
    });

    test("a built-in profile can be turned off, or replaced by a user profile of the same name", () => {
        expect(effectiveConfig({ ...config, disabledProfiles: ["workers"] }, codex, base).applied).toEqual([]);

        const replaced = effectiveConfig(
            { ...config, profiles: [{ name: "workers", match: { agent: "codex" }, askAction: "request" }] },
            codex,
            base
        );

        expect(replaced.config.askAction).toBe("request");
        expect(replaced.config.grace.otherMinutes).toBe(60);
    });

    test("cache presets are off until enabled", () => {
        expect(presetsFor(config).some((p) => p.id === "bun-cache")).toBe(false);
        expect(presetsFor({ ...config, enabledPresets: ["bun-cache"] }).some((p) => p.id === "bun-cache")).toBe(true);
    });

    test("secrets are refused and a .git folder needs the user, even in the session's scratch", () => {
        const c = ctx();
        const key = file(join(c.home, ".ssh", "id_test"), "key");
        const repoGit = dir("cc", "proj", "sess-1111", "clone", ".git");

        expect(verdictOf(key, c)).toEqual({ kind: "deny", rule: "hard-deny" });
        expect(verdictOf(repoGit, c)).toEqual({ kind: "ask", rule: "git-history" });
    });
});

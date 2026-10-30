import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AppApproval,
    type ApprovalDeps,
    appApprovalFromReply,
    assertInsideTrash,
    BUILTIN_PRESETS,
    confirmByPerson,
    createRmRequest,
    defaultRmConfig,
    denyRmRequest,
    drainDue,
    effectiveConfig,
    evaluateTarget,
    filterRmLedger,
    findNestedRepos,
    isInside,
    isTrashRootName,
    listBatches,
    listRmRequests,
    loadRmRequest,
    mayDenyRmRequest,
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
    recheckAfterWait,
    renameNoReplace,
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
        ).toThrow(/with a GenesisTools folder/);
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
            app: async () => ({ kind: "missing" as const, detail: "no app" }),
        };
        const prompt = { title: "t", lines: [], code: "abc" };

        expect((await confirmByPerson({ ...prompt, caller: AGENT }, deps)).via).toBe("dialog");
        expect((await confirmByPerson({ ...prompt, caller: { ...AGENT, isInAgent: false } }, deps)).approved).toBe(
            true
        );
        expect(calls).toEqual(["dialog", "typed"]);
        expect((await confirmByPerson({ ...prompt, caller: AGENT }, { ...deps, platform: "linux" })).via).toBe("none");
    });

    describe("Touch ID through GenesisTools.app", () => {
        const prompt = { title: "t", lines: ["/x"], code: "abc", caller: AGENT };

        function depsWith(app: ApprovalDeps["app"], calls: string[]): ApprovalDeps {
            return {
                interactive: () => true,
                platform: "darwin",
                typed: async () => {
                    calls.push("typed");
                    return true;
                },
                dialog: () => {
                    calls.push("dialog");
                    return true;
                },
                app: async (asked) => {
                    calls.push("app");
                    return app(asked);
                },
            };
        }

        const allowed = async (): Promise<AppApproval> => ({
            kind: "answered",
            outcome: { approved: true, via: "touch-id", detail: "approved with Touch ID" },
        });
        const denied = async (): Promise<AppApproval> => ({
            kind: "answered",
            outcome: { approved: false, via: "touch-id", detail: "denied in the approval window" },
        });
        const missing = async (): Promise<AppApproval> => ({ kind: "missing", detail: "no app" });

        test("auto asks the app first, and its answer is final", async () => {
            const calls: string[] = [];

            expect((await confirmByPerson(prompt, depsWith(allowed, calls))).via).toBe("touch-id");
            expect((await confirmByPerson(prompt, depsWith(denied, calls))).approved).toBe(false);
            expect(calls).toEqual(["app", "app"]);
        });

        test("auto falls back to the code only when there is no app to ask", async () => {
            const calls: string[] = [];
            const outcome = await confirmByPerson(prompt, depsWith(missing, calls));

            expect(outcome.via).toBe("dialog");
            expect(calls).toEqual(["app", "dialog"]);
        });

        test("touch-id refuses without the app, and code never asks it", async () => {
            const calls: string[] = [];
            const strict = await confirmByPerson({ ...prompt, approval: "touch-id" }, depsWith(missing, calls));
            const linux = await confirmByPerson(
                { ...prompt, approval: "touch-id" },
                { ...depsWith(allowed, calls), platform: "linux" }
            );
            const code = await confirmByPerson({ ...prompt, approval: "code" }, depsWith(allowed, calls));

            expect(strict.approved).toBe(false);
            expect(linux.approved).toBe(false);
            expect(code.via).toBe("dialog");
            expect(calls).toEqual(["app", "dialog"]);
        });

        test("only an exact allow approves; a missing app or an old build is not an answer", () => {
            const fail = (code: string) => ({ ok: false as const, error: { code, message: code } });

            for (const code of ["unavailable", "method_unknown", "handshake"]) {
                expect(appApprovalFromReply(fail(code)).kind).toBe("missing");
            }

            expect(appApprovalFromReply(fail("timeout"))).toEqual({
                kind: "answered",
                outcome: { approved: false, via: "touch-id", detail: "timeout: timeout" },
            });
            expect(appApprovalFromReply({ ok: true, result: { decision: "deny" } })).toMatchObject({
                outcome: { approved: false },
            });
            expect(appApprovalFromReply({ ok: true, result: { decision: "allow", method: "password" } })).toMatchObject(
                {
                    outcome: { approved: true, via: "password" },
                }
            );
        });
    });
});

describe("config", () => {
    test("approval defaults to auto and keeps only a known value", () => {
        expect(defaultRmConfig().approval).toBe("auto");
        expect(parseRmConfig({ approval: "touch-id" }).approval).toBe("touch-id");
        expect(parseRmConfig({ approval: "face-id" }).approval).toBe("auto");
    });

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

describe("security review fixes", () => {
    test("a child named ..name is inside its parent; a real .. step is not", () => {
        expect(isInside("/work/app/dist/..important", "/work/app/dist")).toBe(true);
        expect(isInside("/work/app/..dist", "/work/app")).toBe(true);
        expect(isInside("/work/app", "/work/app/dist")).toBe(false);
        expect(isInside("/work/other", "/work/app")).toBe(false);

        const guarded = dir("dots", "dist", "..important");
        file(join(base, "dots", "package.json"), "{}");
        const c = ctx({ config: { ...config, protect: [guarded] } });

        expect(verdictOf(join(base, "dots", "dist"), c)).toEqual({ kind: "deny", rule: "hard-deny" });
    });
});

describe("security review fixes: git pathspecs", () => {
    test("a tracked file whose name holds pathspec magic still counts as tracked", () => {
        const repo = dir("magic");
        git(repo, "init", "-q");
        // `:draft.txt` reads as a pathspec with empty magic for `draft.txt`, so a plain query finds nothing.
        const tricky = file(join(repo, ":draft.txt"), "tracked");
        const bracket = file(join(repo, "draft[1].txt"), "tracked");
        git(repo, "add", "--", ":(literal):draft.txt", ":(literal)draft[1].txt");
        git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
        const c = ctx({ ownFiles: new Set([tricky, bracket]) });

        expect(verdictOf(tricky, c)).toEqual({ kind: "ask", rule: "git-tracked" });
        expect(verdictOf(bracket, c)).toEqual({ kind: "ask", rule: "git-tracked" });
    });
});

describe("security review fixes: detached HEAD", () => {
    test("a clean clone with a commit made on a detached HEAD has unsaved work", () => {
        const origin = dir("detached-origin");
        git(origin, "init", "-q");
        file(join(origin, "a.txt"), "a");
        git(origin, "add", ".");
        git(origin, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
        const clone = join(dir("cc", "proj", "sess-1111"), "detached-clone");
        git(origin, "clone", "-q", origin, clone);
        git(clone, "checkout", "-q", "--detach");
        file(join(clone, "b.txt"), "b");
        git(clone, "add", ".");
        git(clone, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "detached work");

        expect(verdictOf(clone)).toEqual({ kind: "ask", rule: "unsaved-clone" });
    });
});

describe("security review fixes: git metadata", () => {
    test("a path inside a .git folder needs the user, even in the session's scratch", () => {
        const repo = join(dir("cc", "proj", "sess-1111"), "meta-clone");
        git(base, "init", "-q", repo);
        file(join(repo, "a.txt"), "a");
        git(repo, "add", ".");
        git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");

        expect(verdictOf(join(repo, ".git", "objects"))).toEqual({ kind: "ask", rule: "git-history" });
        expect(verdictOf(join(repo, ".git", "HEAD"))).toEqual({ kind: "ask", rule: "git-history" });
        expect(verdictOf(join(repo, ".git"))).toEqual({ kind: "ask", rule: "git-history" });
    });
});

describe("security review fixes: repositories inside the session's scratch", () => {
    test("a scratch folder holding a linked worktree is refused, a dirty clone asks, a clean clone goes", () => {
        const origin = dir("nested-origin");
        git(origin, "init", "-q");
        file(join(origin, "a.txt"), "a");
        git(origin, "add", ".");
        git(origin, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");

        const withWorktree = dir("cc", "proj", "sess-1111", "wt-holder");
        git(origin, "worktree", "add", "-q", "--detach", join(withWorktree, "wt"));
        const withDirty = dir("cc", "proj", "sess-1111", "dirty-holder");
        git(origin, "clone", "-q", origin, join(withDirty, "clone"));
        file(join(withDirty, "clone", "new.txt"), "new work");
        const withClean = dir("cc", "proj", "sess-1111", "clean-holder");
        git(origin, "clone", "-q", origin, join(withClean, "clone"));

        expect(verdictOf(withWorktree)).toEqual({ kind: "deny", rule: "registered-worktree" });
        expect(verdictOf(withDirty)).toEqual({ kind: "ask", rule: "nested-repos" });
        expect(verdictOf(withClean)).toEqual({ kind: "allow", rule: "session-scratch" });
    });
});

describe("security review fixes: unsaved work stays in place", () => {
    test("an ask marks unsaved work whichever rule answered: dirty tracked files, untracked ones, a .git folder", () => {
        const repo = dir("unsaved-repo");
        git(repo, "init", "-q");
        file(join(repo, "clean", "a.ts"), "a");
        file(join(repo, "edited", "b.ts"), "b");
        file(join(repo, "mixed", "c.ts"), "c");
        git(repo, "add", ".");
        git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
        file(join(repo, "edited", "b.ts"), "an edit no commit has");
        file(join(repo, "mixed", "new.ts"), "new work");
        const unsavedOf = (path: string) => {
            const c = ctx();
            const verdict = evaluateTarget(resolveTarget(path, c.cwd), c);
            return { rule: verdict.rule, unsaved: verdict.unsaved ?? false };
        };

        expect(unsavedOf(join(repo, "clean"))).toEqual({ rule: "git-tracked", unsaved: false });
        expect(unsavedOf(join(repo, "edited"))).toEqual({ rule: "git-tracked", unsaved: true });
        expect(unsavedOf(join(repo, "edited", "b.ts"))).toEqual({ rule: "git-tracked", unsaved: true });
        expect(unsavedOf(join(repo, "mixed"))).toEqual({ rule: "git-tracked", unsaved: true });
        expect(unsavedOf(join(repo, ".git"))).toEqual({ rule: "git-history", unsaved: true });
    });
});

describe("security review fixes: config", () => {
    test("a custom opt-in preset stays off after a load until its id is enabled", () => {
        const custom = { id: "shared-cache", description: "a shared cache", names: ["cache"], optIn: true };
        const loaded = parseRmConfig({ customPresets: [custom] });

        expect(loaded.customPresets[0]?.optIn).toBe(true);
        expect(presetsFor(loaded).some((p) => p.id === "shared-cache")).toBe(false);
        expect(presetsFor({ ...loaded, enabledPresets: ["shared-cache"] }).some((p) => p.id === "shared-cache")).toBe(
            true
        );
    });
});

describe("security review fixes: trash root", () => {
    test("a trash root with a .. step, or one that resolves outside a GenesisTools folder, is refused", () => {
        const sneaky = "/tmp/GenesisTools/../../home/alice";

        expect(isTrashRootName(sneaky)).toBe(false);
        expect(parseRmConfig({ trashRoot: sneaky }).trashRoot).toBe(defaultRmConfig().trashRoot);

        const victim = dir("victim-home");
        const victimFile = file(join(victim, "batch", "item"), "keep");
        const link = join(dir("linked", "GenesisTools"), "rm");
        symlinkSync(victim, link);
        const linked = { ...config, trashRoot: link };

        expect(() => assertInsideTrash(victimFile, linked, "item")).toThrow(/resolves to/);
        expect(existsSync(victimFile)).toBe(true);
    });
});

describe("security review fixes: private trash", () => {
    test("the trash and aside folders are closed to other users, and a linked trash root moves nothing", () => {
        const root = join(dir("private-trash", "GenesisTools"), "rm");
        mkdirSync(root, { mode: 0o755 });
        chmodSync(root, 0o755);
        const own = { ...config, trashRoot: root };
        // Its own records, so the suite's final drain (under the shared root) does not meet this root's batch.
        const ownPaths = {
            batchesDir: join(base, "private-state", "batches"),
            lockPath: join(base, "private-state", "l"),
        };
        const victim = file(join(dir("private-src"), "draft.md"), "work");
        const batch = moveToTrash([{ target: resolveTarget(victim, base), rule: "test" }], {
            config: own,
            caller: AGENT,
            graceMinutes: 60,
            paths: ownPaths,
        });

        expect(batch?.items).toHaveLength(1);
        expect(statSync(root).mode & 0o777).toBe(0o700);

        const elsewhere = dir("private-elsewhere");
        const linkedRoot = join(dir("private-linked", "GenesisTools"), "rm");
        symlinkSync(elsewhere, linkedRoot);
        const kept = file(join(dir("private-src2"), "draft.md"), "work");

        expect(() =>
            moveToTrash([{ target: resolveTarget(kept, base), rule: "test" }], {
                config: { ...config, trashRoot: linkedRoot },
                caller: AGENT,
                graceMinutes: 60,
                paths: ownPaths,
            })
        ).toThrow(/not a plain folder|resolves to/);
        expect(existsSync(kept)).toBe(true);

        const asideRoot = dir("cc", "proj", "sess-1111", "private-aside");
        chmodSync(asideRoot, 0o755);
        const draft = file(join(dir("private-src3"), "draft.md"), "work");
        const verdict = { kind: "ask" as const, rule: "default", reason: "test" };
        const aside = moveAside([{ target: resolveTarget(draft, base), verdict }], AGENT, "b1", asideRoot);

        expect(aside.moved).toHaveLength(1);
        expect(statSync(asideRoot).mode & 0o777).toBe(0o700);
    });
});

describe("security review fixes: the path is checked, then moved", () => {
    function moveOne(target: ReturnType<typeof resolveTarget>, hooks?: { beforeRename?: () => void }) {
        const refused: string[] = [];
        const batch = moveToTrash([{ target, rule: "test" }], {
            config,
            caller: AGENT,
            graceMinutes: 60,
            paths: trashPaths,
            hooks,
            onRefused: (_move, reason) => refused.push(reason),
        });
        return { batch, refused };
    }

    test("a file swapped in after the check is not trashed", () => {
        const path = file(join(dir("race-file"), "draft.md"), "checked");
        const target = resolveTarget(path, base);
        renameSync(path, `${path}.moved`);
        file(path, "a different file");

        const { batch, refused } = moveOne(target);

        expect(batch).toBeNull();
        expect(refused[0]).toMatch(/another file or folder/);
        expect(readFileSync(path, "utf8")).toBe("a different file");
    });

    test("a parent folder swapped for a symlink after the check moves nothing behind the link", () => {
        const parent = dir("race-parent", "work");
        file(join(parent, "out.log"), "checked");
        const target = resolveTarget(join(parent, "out.log"), base);
        const precious = file(join(dir("race-precious"), "out.log"), "precious");
        renameSync(parent, `${parent}.old`);
        symlinkSync(join(base, "race-precious"), parent);

        const { batch, refused } = moveOne(target);

        expect(batch).toBeNull();
        expect(refused[0]).toMatch(/now resolves to/);
        expect(readFileSync(precious, "utf8")).toBe("precious");
    });

    test("a swap inside the window between the last check and the rename is put back and refused", () => {
        const path = file(join(dir("race-window"), "draft.md"), "checked");
        const target = resolveTarget(path, base);
        const swap = () => {
            renameSync(path, `${path}.moved`);
            file(path, "swapped in at the last moment");
        };

        const { batch, refused } = moveOne(target, { beforeRename: swap });

        expect(batch).toBeNull();
        expect(refused[0]).toMatch(/swapped during the move; put back/);
        expect(readFileSync(path, "utf8")).toBe("swapped in at the last moment");
    });

    test("after the wait, a path that became a linked worktree is refused; an unchanged one passes", () => {
        const origin = dir("race-origin");
        git(origin, "init", "-q");
        file(join(origin, "a.txt"), "a");
        git(origin, "add", ".");
        git(origin, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
        const later = dir("race-later");
        const pinned = resolveTarget(later, base);
        const c = ctx();

        expect(recheckAfterWait(pinned, c)).toBeNull();

        git(origin, "worktree", "add", "-q", "--detach", join(later, "wt"));

        expect(recheckAfterWait(pinned, c)).toMatch(/linked worktree/);
    });
});

describe("security review fixes: a put-back never replaces", () => {
    test("renameNoReplace refuses a taken file or folder name and leaves both sides whole", () => {
        const from = file(join(dir("noreplace"), "from.txt"), "aside copy");
        const to = file(join(base, "noreplace", "to.txt"), "new work");

        expect(() => renameNoReplace(from, to)).toThrow();
        expect(readFileSync(to, "utf8")).toBe("new work");
        expect(readFileSync(from, "utf8")).toBe("aside copy");

        const fromDir = dir("noreplace", "from-dir");
        file(join(fromDir, "a.txt"), "a");
        const emptyDir = dir("noreplace", "empty-dir");

        expect(() => renameNoReplace(fromDir, emptyDir)).toThrow();
        expect(existsSync(join(fromDir, "a.txt"))).toBe(true);

        renameNoReplace(from, join(base, "noreplace", "free.txt"));
        expect(readFileSync(join(base, "noreplace", "free.txt"), "utf8")).toBe("aside copy");
        expect(existsSync(from)).toBe(false);
    });

    test("deny keeps the aside copy when the original path is recreated between the check and the move", () => {
        for (const kind of ["file", "dir"] as const) {
            const original = join(dir("putback", kind), "draft");
            const stored = join(dir("putback", kind, "aside"), "0-draft");

            if (kind === "file") {
                file(stored, "aside copy");
            } else {
                file(join(stored, "inner.txt"), "aside copy");
            }

            const target = { path: original, kind, rule: "default", reason: "test", stored };
            const recreate = () => {
                if (kind === "file") {
                    file(original, "recreated meanwhile");
                } else {
                    mkdirSync(original);
                }
            };
            const back = returnAside([target], AGENT, "req1", { beforeMove: recreate });

            expect(back.returned).toEqual([]);
            expect(back.kept[0]?.reason).toMatch(/something exists there now/);
            expect(existsSync(stored)).toBe(true);

            if (kind === "file") {
                expect(readFileSync(original, "utf8")).toBe("recreated meanwhile");
            }
        }
    });
});

describe("security review fixes: deny", () => {
    test("an agent may deny only its own request; a person may deny any", () => {
        const request = createRmRequest(
            { kind: "delete", caller: AGENT, cwd: base, reason: null, targets: [] },
            dir("deny-own-requests")
        );

        expect(mayDenyRmRequest(request, AGENT)).toBe(true);
        expect(mayDenyRmRequest(request, { ...AGENT, sessionId: "sess-2222" })).toBe(false);
        expect(mayDenyRmRequest(request, { ...AGENT, agent: "codex" })).toBe(false);
        expect(mayDenyRmRequest(request, { ...AGENT, sessionId: null })).toBe(false);
        expect(mayDenyRmRequest(request, { ...AGENT, isInAgent: false, sessionId: null })).toBe(true);
    });

    test("a copy that cannot go home keeps the request pending and its aside folder guarded", () => {
        const requestsDir = dir("deny-kept-requests");
        const src = file(join(dir("deny-kept-src"), "draft.md"), "work");
        const verdict = { kind: "ask" as const, rule: "default", reason: "test" };
        const asideRoot = dir("cc", "proj", "sess-1111", "deny-kept-aside");
        const aside = moveAside([{ target: resolveTarget(src, base), verdict }], AGENT, "b1", asideRoot);
        const request = createRmRequest(
            { kind: "delete", caller: AGENT, cwd: base, reason: null, targets: aside.moved, asideDir: aside.dir },
            requestsDir
        );
        file(src, "the agent wrote a new file there meanwhile");

        const back = denyRmRequest(request, AGENT, { requestsDir });

        expect(back.waiting).toHaveLength(1);
        expect(loadRmRequest(request.id, requestsDir)?.status).toBe("pending");
        expect(pendingAsideFor(realpathSync(aside.dir), pendingAsideDirs(requestsDir))).toBe(request.id);

        unlinkSync(src);
        const again = denyRmRequest(loadRmRequest(request.id, requestsDir) ?? request, AGENT, { requestsDir });

        expect(again.returned).toEqual([src]);
        expect(loadRmRequest(request.id, requestsDir)?.status).toBe("denied");
    });
});

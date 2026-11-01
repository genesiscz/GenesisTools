import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { sessionScratchPath } from "../../../plugins/genesis-tools/hooks/session-scratch";
import {
    type AppApproval,
    type ApprovalDeps,
    ApprovalUpdates,
    acquireDrainerLock,
    appApprovalFromReply,
    appApproveParams,
    appendRmLedger,
    approvalAsker,
    approvalGraceMinutes,
    approvalItemReason,
    asideRootFor,
    assertInsideTrash,
    BUILTIN_PRESETS,
    confirmByPerson,
    createAsideRequest,
    createRmRequest,
    defaultRmConfig,
    disposalGraceMinutes,
    drainDue,
    effectiveConfig,
    evaluateTarget,
    filterRmLedger,
    findNestedRepos,
    folderStats,
    graceMinutesFor,
    isInside,
    isRootActive,
    isTrashRootName,
    itemGitState,
    ledgerAgent,
    listBatches,
    listRmRequests,
    loadRmConfig,
    loadRmMeasurements,
    loadRmRequest,
    lockRmRequest,
    mayDenyRmRequest,
    measureBytes,
    measureBytesAsync,
    measureRmRequest,
    measureTarget,
    moveAside,
    moveToTrash,
    parseRmConfig,
    pathPresent,
    pendingAsideDirs,
    pendingAsideFor,
    planRemoval,
    presetsFor,
    printApprovalUpdates,
    priorDenials,
    probeGit,
    probeItemGit,
    pruneRmRequests,
    RM_REQUEST_TTL_MS,
    type RmCaller,
    type RmConfig,
    type RmLedgerEntry,
    type RmRequest,
    type RmRuleContext,
    readRmLedger,
    readRmLedgerNewest,
    readRmRequestFile,
    recheckAfterWait,
    recordRmMeasurement,
    recoverAsideJournals,
    refreshWaitingRmData,
    rememberOptions,
    removeStaleLock,
    renameNoReplace,
    replyChoices,
    requestBatchId,
    requestLive,
    requestsAlsoNaming,
    resolveTarget,
    restoreBatch,
    returnAside,
    rmLedgerPath,
    rmMeasurementsDir,
    rmRequestLockFile,
    runDrainer,
    saveRmConfig,
    saveRmRequest,
    scanPresets,
    sweepOrphans,
    type TrashPaths,
    targetChangeReason,
    totalRmLedger,
    trashItemName,
    trashRootChangeBlocker,
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
    // A move re-reads the saved trash root once its claim is on record, so the suite's root is the saved one.
    saveRmConfig(config);
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

    test("within presets never select siblings outside the requested root", () => {
        const within = dir("scoped-preset");
        const projectA = dir("scoped-preset", "project-a");
        dir("scoped-preset", "project-b");
        const preset = { id: "scoped", description: "test", names: [], within };

        expect(scanPresets(projectA, [preset]).map((match) => match.path)).toEqual([projectA]);
        expect(scanPresets(within, [preset])).toHaveLength(2);
        expect(scanPresets(dir("scoped-preset", "project-a", "nested"), [preset])).toEqual([]);
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

    test("the approval window's git facts: one status per repository, the last commit of a tracked path", async () => {
        const outside = dir("cwd");
        const facts = await probeItemGit([
            { path: join(repo, "src") },
            { path: join(repo, "dist") },
            { path: join(repo, "notes.md") },
            { path: outside },
        ]);

        expect(facts.get(join(repo, "src"))).toMatchObject({ state: "clean", repo });
        expect(facts.get(join(repo, "src"))?.lastCommit).toMatch(/^[0-9a-f]{7,} .+: init$/);
        expect(facts.get(join(repo, "dist"))).toEqual({ state: "ignored", repo });
        expect(facts.get(join(repo, "notes.md"))).toEqual({ state: "untracked", repo });
        expect(facts.get(outside)).toEqual({ state: "none" });
    });
});

describe("git state of an approval item", () => {
    const deleted = { kind: "changed" as const, path: "src/a.ts", index: ".", worktree: "D" };

    test("a tracked folder moved aside is clean; the same deletion in place is a change", () => {
        expect(itemGitState({ entries: [deleted], rel: "src", aside: true, tracked: true })).toBe("clean");
        expect(itemGitState({ entries: [deleted], rel: "src", aside: false, tracked: true })).toBe("modified");
    });

    test("an untracked or ignored folder around the path decides it; a path no commit holds is untracked", () => {
        const untracked = { kind: "untracked" as const, path: "new/", index: "?", worktree: "?" };
        const ignored = { kind: "ignored" as const, path: "build/", index: "!", worktree: "!" };

        expect(itemGitState({ entries: [untracked], rel: "new/x.ts", aside: false, tracked: false })).toBe("untracked");
        expect(itemGitState({ entries: [ignored], rel: "build/out", aside: false, tracked: false })).toBe("ignored");
        expect(itemGitState({ entries: [], rel: "empty", aside: false, tracked: false })).toBe("untracked");
    });
});

describe("folder stats", () => {
    test("counts the files and the newest change, and says when the walk stopped at its cap", () => {
        const folder = dir("stats");
        file(join(folder, "a.txt"));
        file(join(folder, "deep", "b.txt"));
        const newest = file(join(folder, "deep", "c.txt"));
        utimesSync(newest, new Date("2030-01-02T03:04:05Z"), new Date("2030-01-02T03:04:05Z"));

        expect(folderStats(folder)).toEqual({ files: 3, newestAt: "2030-01-02T03:04:05.000Z" });
        expect(folderStats(folder, 2).capped).toBe(true);
    });

    test("caps a flat directory and distinguishes an exact cap", () => {
        const folder = dir("flat-stats");
        for (let i = 0; i < 25; i++) {
            file(join(folder, `${i}.txt`));
        }
        expect(folderStats(folder, 4)).toMatchObject({ files: 4, capped: true });
        expect(folderStats(folder, 25)).toMatchObject({ files: 25 });
        expect(folderStats(folder, 25).capped).toBeUndefined();
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

    test("the session's own scratch waits the scratch grace, a preset folder the preset grace, the rest the other", () => {
        const c = ctx();
        const allow = (rule: string) => ({ kind: "allow" as const, rule, reason: "" });
        const scratch = resolveTarget(dir("cc", "proj", "sess-1111", "out"), c.cwd);
        file(join(base, "cc", "proj", "sess-1111", "app", "package.json"), "{}");
        const modules = resolveTarget(dir("cc", "proj", "sess-1111", "app", "node_modules"), c.cwd);
        const rooted = resolveTarget(dir("trusted-grace", "x"), c.cwd);

        expect(graceMinutesFor({ target: scratch, verdict: allow("session-scratch") }, c)).toBe(5);
        expect(graceMinutesFor({ target: modules, verdict: allow("session-scratch") }, c)).toBe(0);
        expect(graceMinutesFor({ target: rooted, verdict: allow("root") }, c)).toBe(60);
        expect(graceMinutesFor({ target: scratch, verdict: allow("session-scratch") }, c, 2)).toBe(2);
        const slow = ctx({ config: { ...config, grace: { ...config.grace, scratchMinutes: 20 } } });
        expect(graceMinutesFor({ target: scratch, verdict: allow("session-scratch") }, slow)).toBe(20);
    });

    test("a trusted root allows what is inside it, never the root itself", () => {
        const root = dir("trusted");
        const c = ctx({ config: { ...config, roots: [{ path: root, addedAt: "", via: "cli" }] } });

        expect(verdictOf(dir("trusted", "x"), c)).toEqual({ kind: "allow", rule: "root" });
        expect(verdictOf(root, c)).toEqual({ kind: "ask", rule: "default" });
    });

    test("an allowed path inside an asked folder stays in the plan; an asked one inside it goes with the folder", () => {
        const root = dir("trusted-overlap");
        const c = ctx({ config: { ...config, roots: [{ path: root, addedAt: "", via: "cli" }] } });
        const allowedChild = dir("trusted-overlap", "build");
        const theirs = dir("cc", "proj", "sess-2222", "overlap");
        const plan = planRemoval([root, allowedChild, theirs, dir("cc", "proj", "sess-2222", "overlap", "inner")], c);

        expect(plan.map((item) => [item.target.path, item.verdict.kind])).toEqual([
            [root, "ask"],
            [allowedChild, "allow"],
            [theirs, "ask"],
        ]);
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

    test("an unwritable trash refuses the affected path and continues with writable targets", () => {
        const blocked = resolveTarget(file(join(dir("unwritable-trash"), "blocked")), base);
        const normal = resolveTarget(file(join(dir("unwritable-trash"), "normal")), base);
        const refused: string[] = [];
        const batch = moveToTrash(
            [
                { target: blocked, rule: "test" },
                { target: normal, rule: "test" },
            ],
            {
                config,
                caller: AGENT,
                graceMinutes: 60,
                paths: trashPaths,
                hooks: {
                    beforeTrashRoot: (request) => {
                        if (request.target.path === blocked.path) {
                            throw Object.assign(new Error("mount is unwritable"), { code: "EACCES" });
                        }
                    },
                },
                onRefused: (request, reason) => {
                    refused.push(`${request.target.path}: ${reason}`);
                },
            }
        );
        expect(refused).toHaveLength(1);
        expect(refused[0]).toContain("kept in place");
        expect(existsSync(blocked.path)).toBe(true);
        expect(existsSync(normal.path)).toBe(false);
        expect(batch?.items.map((item) => item.original)).toEqual([normal.path]);
        expect(restoreBatch(batch?.id ?? "", { config, paths: trashPaths }).restored).toContain(normal.path);
    });

    test("an unwritable cross-volume fallback leaves the target in place", () => {
        const target = resolveTarget(file(join(dir("unwritable-fallback"), "file")), base);
        const refused: string[] = [];
        const options = {
            config,
            caller: AGENT,
            graceMinutes: 60,
            paths: trashPaths,
            hooks: {
                beforeRename: () => {
                    throw Object.assign(new Error("cross-volume"), { code: "EXDEV" });
                },
                beforeVolumeTrash: () => {
                    throw Object.assign(new Error("read-only mount"), { code: "EROFS" });
                },
            },
        };
        const batch = moveToTrash([{ target, rule: "test" }], {
            ...options,
            onRefused: (_request, reason) => refused.push(reason),
        });
        expect(batch).toBeNull();
        expect(refused[0]).toContain("EROFS");
        expect(existsSync(target.path)).toBe(true);
        expect(() => moveToTrash([{ target, rule: "test" }], options)).toThrow(/kept in place/);
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
        const person = { ...AGENT, isInAgent: false };

        expect((await confirmByPerson({ ...prompt, approval: "code", caller: person }, deps)).approved).toBe(true);
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

        test("a window whose process ended without an answer is asked again, not replaced by the dialog", async () => {
            const calls: string[] = [];
            let first = true;
            const endedThenAllowed = async (): Promise<AppApproval> => {
                if (first) {
                    first = false;
                    return { kind: "missing", detail: "rm.approve produced no reply (exit 143)" };
                }

                return allowed();
            };
            const outcome = await confirmByPerson(prompt, depsWith(endedThenAllowed, calls));

            expect(outcome.via).toBe("touch-id");
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

        test("the window gets the request's rows beside the terminal's lines, and a settings change only lines", () => {
            const request = {
                id: "abc234",
                kind: "delete" as const,
                why: "old exports",
                cwd: "/work/shop",
                graceMinutes: 60,
                asker: approvalAsker({ ...AGENT, sessionTitle: "shop-admin", project: "shop", branch: "main" }),
                items: [{ path: "/work/shop/out", kind: "dir" as const, bytes: 0, empty: true, reason: "Outside" }],
            };
            const withRequest = appApproveParams({ ...prompt, request }, "/elsewhere");
            const settings = appApproveParams(prompt, "/elsewhere");

            expect(withRequest).toMatchObject({ title: "t", lines: ["/x"], folder: "/work/shop", request });
            expect(request.asker).toEqual({
                agent: "Claude Code",
                session: "shop-admin",
                project: "shop",
                branch: "main",
                sessionId: "sess-1111",
                provider: "claude",
            });
            expect(settings).toEqual({
                title: "t",
                lines: ["/x"],
                caller: "Claude Code",
                folder: "/elsewhere",
            });
            expect("request" in settings).toBe(false);
            expect(approvalAsker({ ...AGENT, isInAgent: false })).toBeUndefined();
        });

        test("a rule's terminal reason becomes one sentence a person reads", () => {
            const home = "/Users/someone";

            expect(
                approvalItemReason(
                    "default",
                    "no rule allows it: a preset, this session's scratch or own files, or a trusted root",
                    home
                )
            ).toBe("Outside this session's scratch, its own files and the trusted folders");
            expect(
                approvalItemReason(
                    "git-untracked",
                    "3 untracked file(s) git does not ignore in /Users/someone/Notes: may be new work",
                    home
                )
            ).toBe("Holds 3 files git does not track in ~/Notes, which may be new work");
            expect(
                approvalItemReason(
                    "git-tracked",
                    "1 file(s) tracked by git in /srv/app: use git rm, or ask the user",
                    home
                )
            ).toBe("Holds 1 file tracked by git in /srv/app");
            // The rule words a count for a person: "1 file", "3 untracked files"; a request saved before reads too.
            expect(
                approvalItemReason(
                    "git-tracked",
                    "1 file tracked by git in /srv/app: use git rm, or ask the user",
                    home
                )
            ).toBe("Holds 1 file tracked by git in /srv/app");
            expect(
                approvalItemReason(
                    "git-untracked",
                    "3 untracked files git does not ignore in /Users/someone/Notes: may be new work",
                    home
                )
            ).toBe("Holds 3 files git does not track in ~/Notes, which may be new work");
            expect(
                approvalItemReason("nested-repos", "holds 2 git repositories, e.g. /Users/someone/x/.git", home)
            ).toBe("Holds 2 git repositories, such as ~/x/.git");
            expect(approvalItemReason("unsaved-clone", "a clone with 2 unpushed commits.", home)).toBe(
                "A clone with 2 unpushed commits"
            );
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

describe("approval window choices", () => {
    test("the reply's picks are read, and a missing or unknown value is the default", () => {
        expect(replyChoices({ decision: "allow" })).toEqual({
            selected: null,
            disposal: "trash",
            remember: "once",
            note: null,
        });
        expect(
            replyChoices({
                decision: "allow",
                selected: ["/a", 3],
                disposal: "permanent",
                remember: "session",
                note: "  ",
            })
        ).toEqual({ selected: ["/a"], disposal: "permanent", remember: "session", note: null });
        expect(replyChoices({ decision: "allow", disposal: "shred", remember: "forever" })).toMatchObject({
            disposal: "trash",
            remember: "once",
        });
    });

    test("a person's deny carries its note; the window's give-up is not a person's deny", () => {
        const reply = (decision: string, reason: string, note?: string) =>
            appApprovalFromReply({ ok: true, result: { decision, method: "none", reason, note } });
        const personal = reply("deny", "denied in the approval window", "keep the fixtures");
        const timeout = reply("deny", "no answer within 170s");

        expect(personal.kind === "answered" && personal.outcome).toMatchObject({
            approved: false,
            deniedByPerson: true,
            choices: { note: "keep the fixtures" },
        });
        expect(timeout.kind === "answered" && timeout.outcome.deniedByPerson).toBe(false);
    });

    test("the params keep their old keys and add remember only when the request offers it", () => {
        const prompt = { title: "t", lines: ["/x"], code: "abc", caller: AGENT };

        expect(Object.keys(appApproveParams(prompt, "/cwd"))).toEqual(["title", "lines", "caller", "folder"]);
        expect(appApproveParams({ ...prompt, remember: rememberOptions("delete", AGENT) }, "/cwd").remember).toEqual([
            { id: "once", title: "Just this once" },
            { id: "session", title: "This session, this folder" },
            { id: "folder", title: "Always for this folder" },
        ]);
        expect(rememberOptions("delete", { ...AGENT, sessionId: null }).map((o) => o.id)).toEqual(["once", "folder"]);
        expect(rememberOptions("root", AGENT)).toEqual([]);
        expect(rememberOptions("delete", { agent: "person", sessionId: null, isInAgent: false })).toEqual([]);
    });

    test("the asker carries its session id and provider for the window's links", () => {
        expect(approvalAsker(AGENT)).toMatchObject({ sessionId: "sess-1111", provider: "claude" });
        expect(approvalAsker({ ...AGENT, agent: "codex" })?.provider).toBe("codex");
    });

    test("a permanent delete has no grace; the trash keeps an approved item 10 minutes", () => {
        expect(disposalGraceMinutes("permanent")).toBe(0);
        expect(disposalGraceMinutes("trash")).toBe(10);
        expect(disposalGraceMinutes("permanent", 30)).toBe(0);
    });
});

describe("request lookups", () => {
    function request(id: string, overrides: Partial<RmRequest> = {}): RmRequest {
        return {
            id,
            kind: "delete",
            createdAt: "2026-10-30T10:00:00.000Z",
            caller: AGENT,
            cwd: "/w",
            reason: null,
            targets: [{ path: "/w/a", kind: "file", rule: "default", reason: "r" }],
            status: "pending",
            ...overrides,
        };
    }

    test("another pending request naming the same path is listed as alsoIn", () => {
        const all = [request("aaaaaa"), request("bbbbbb"), request("cccccc", { status: "denied" })];

        expect(requestsAlsoNaming(["/w/a", "/w/b"], "aaaaaa", all)).toEqual(new Map([["/w/a", ["bbbbbb"]]]));
    });

    test("a person's earlier deny is found for the same session only, and an agent's own cancel never", () => {
        const all = [
            request("dddddd", {
                status: "denied",
                decidedVia: "touch-id",
                decidedAt: "2026-10-30T11:00:00.000Z",
                deniedNote: "not the fixtures",
            }),
            request("eeeeee", { status: "denied", decidedVia: "cli", decidedAt: "2026-10-30T12:00:00.000Z" }),
        ];

        expect(priorDenials(["/w/a"], "sess-1111", all)).toEqual([
            { path: "/w/a", requestId: "dddddd", decidedAt: "2026-10-30T11:00:00.000Z", note: "not the fixtures" },
        ]);
        expect(priorDenials(["/w/a"], "sess-other", all)).toEqual([]);
        expect(priorDenials(["/w/a"], null, all)).toEqual([]);
    });

    test("restore by request id resolves to the batch its approval made", () => {
        const requestsDir = dir("batch-requests");
        saveRmRequest(request("ffffff", { status: "approved", batchId: "20261030-batch" }), requestsDir);

        expect(requestBatchId("ffffff", requestsDir)).toBe("20261030-batch");
        expect(requestBatchId("gggggg", requestsDir)).toBeNull();
    });
});

describe("config", () => {
    test("the settings added on 2026-11-01 have their defaults, and a config saved before them reads those", () => {
        const fresh = defaultRmConfig();

        expect(fresh.tmpSmallMB).toBe(10);
        expect(fresh.ownFilesFromBash).toBe(true);
        expect(fresh.grace.scratchMinutes).toBe(5);
        expect(fresh.notify).toEqual({ onRequest: "inbox", onFailure: "inbox", askMinMB: 10 });
        expect(fresh.sweep).toEqual({ everyMinutes: 5, lingerMinutes: 60 });

        const old = parseRmConfig({ grace: { presetMinutes: 0, otherMinutes: 30 }, notify: { onRequest: "none" } });
        expect(old.tmpSmallMB).toBe(10);
        expect(old.grace).toEqual({ presetMinutes: 0, otherMinutes: 30, scratchMinutes: 5 });
        expect(old.notify).toEqual({ onRequest: "none", onFailure: "inbox", askMinMB: 10 });
        expect(old.sweep).toEqual({ everyMinutes: 5, lingerMinutes: 60 });

        const set = parseRmConfig({
            tmpSmallMB: 0,
            ownFilesFromBash: false,
            grace: { scratchMinutes: 1 },
            notify: { onFailure: "notification", askMinMB: 0 },
            sweep: { everyMinutes: 2, lingerMinutes: 0 },
        });
        expect([set.tmpSmallMB, set.ownFilesFromBash, set.grace.scratchMinutes]).toEqual([0, false, 1]);
        expect(set.notify).toEqual({ onRequest: "inbox", onFailure: "notification", askMinMB: 0 });
        expect(set.sweep).toEqual({ everyMinutes: 2, lingerMinutes: 0 });
    });

    test("a wrong value of a new setting fails the config closed", () => {
        const path = join(dir("bad-config"), "config.json");

        for (const bad of [
            { tmpSmallMB: -1 },
            { ownFilesFromBash: "yes" },
            { grace: { scratchMinutes: "5" } },
            { notify: { onFailure: "mail" } },
            { notify: { askMinMB: -3 } },
            { sweep: { everyMinutes: 0 } },
            { sweep: "often" },
        ]) {
            writeFileSync(path, SafeJSON.stringify(bad));
            expect(() => loadRmConfig(path)).toThrow("invalid safety config");
        }
    });

    test("a profile may change the tmp-small cap, the Bash own files and the scratch grace", () => {
        const custom = {
            ...config,
            profiles: [
                {
                    name: "careful",
                    match: { agent: "codex" },
                    tmpSmallMB: 0,
                    ownFilesFromBash: false,
                    grace: { scratchMinutes: 30 },
                },
            ],
        };
        const codex: RmCaller = { agent: "codex", sessionId: "cdx-1", isInAgent: true };
        const effective = effectiveConfig(parseRmConfig(custom), codex, base).config;

        expect([effective.tmpSmallMB, effective.ownFilesFromBash, effective.grace.scratchMinutes]).toEqual([
            0,
            false,
            30,
        ]);
        expect(effectiveConfig(parseRmConfig(custom), AGENT, base).config.grace.scratchMinutes).toBe(5);
    });

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

    test("a remembered root counts only for its session and only until it expires", () => {
        const now = Date.parse("2026-10-30T12:00:00Z");
        const scoped = parseRmConfig({
            roots: [
                { path: "/w", addedAt: "", via: "request:x", session: "sess-1111", expiresAt: "2026-10-30T20:00:00Z" },
            ],
        }).roots[0];

        expect(scoped).toMatchObject({ session: "sess-1111", expiresAt: "2026-10-30T20:00:00Z" });
        expect(scoped && isRootActive(scoped, "sess-1111", now)).toBe(true);
        expect(scoped && isRootActive(scoped, "sess-other", now)).toBe(false);
        expect(scoped && isRootActive(scoped, "sess-1111", Date.parse("2026-10-30T21:00:00Z"))).toBe(false);
        expect(isRootActive({ path: "/w", addedAt: "", via: "cli" }, null, now)).toBe(true);
    });

    test("the root rule skips a root of another session", () => {
        const inside = file(join(dir("session-root"), "x.txt"));
        const roots = [{ path: dir("session-root"), addedAt: "", via: "request:x", session: "sess-other" }];

        expect(verdictOf(inside, ctx({ config: { ...config, roots } })).rule).toBe("default");
        expect(
            verdictOf(inside, ctx({ config: { ...config, roots: [{ ...roots[0], session: "sess-1111" }] } })).rule
        ).toBe("root");
    });
});

describe("aside", () => {
    test("moves a path aside, the pending batch is refused to everyone, deny puts it back", () => {
        const requestsDir = dir("aside-requests");
        const src = file(join(dir("aside-src"), "draft.md"), "work");
        const target = resolveTarget(src, base);
        const verdict = { kind: "ask" as const, rule: "git-tracked", reason: "tracked" };
        const aside = moveAside({
            inputs: [{ target, verdict }],
            caller: AGENT,
            batchId: "b1",
            root: dir("cc", "proj", "sess-1111", "rm-aside"),
        });

        expect(aside.moved).toHaveLength(1);
        expect(existsSync(src)).toBe(false);
        // The move does not walk the copy: the request's measurement pass sizes it, so the asking run returns at once.
        expect(aside.moved[0]?.bytes).toBeUndefined();

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

describe("macOS tmp_cleaner: what waits in /tmp keeps fresh times", () => {
    const OLD = new Date("2026-01-01T00:00:00.000Z");
    const VERDICT = { kind: "ask" as const, rule: "default", reason: "no rule allows it" };
    /** The files of a tree `oldTree` made, relative to its root. */
    const FILES = ["a.txt", join("deep", "b.txt")];

    /** Two files (one nested) and an empty folder, all with 2026-01-01 access and modification times. */
    function oldTree(name: string): string {
        const root = dir("tmp-cleaner", name);

        for (const relative of FILES) {
            utimesSync(file(join(root, relative)), OLD, OLD);
        }

        utimesSync(dir("tmp-cleaner", name, "empty"), OLD, OLD);
        return root;
    }

    function age(stored: string): void {
        for (const relative of FILES) {
            utimesSync(join(stored, relative), OLD, OLD);
        }
    }

    /** Every file read within the last minute (so changed then too), its modification time still 2026-01-01. */
    function expectFresh(stored: string): void {
        for (const relative of FILES) {
            const stat = statSync(join(stored, relative));
            expect(Date.now() - stat.atimeMs).toBeLessThan(60_000);
            expect(Date.now() - stat.ctimeMs).toBeLessThan(60_000);
            expect(stat.mtimeMs).toBe(OLD.getTime());
        }
    }

    function expectOld(stored: string): void {
        for (const relative of FILES) {
            expect(statSync(join(stored, relative)).atimeMs).toBe(OLD.getTime());
        }
    }

    test("a move aside and a move into a trash batch with a grace refresh every file, and no grace leaves them", () => {
        const asideTree = oldTree("aside");
        expectOld(asideTree);
        const aside = moveAside({
            inputs: [{ target: resolveTarget(asideTree, base), verdict: VERDICT }],
            caller: AGENT,
            batchId: "tmp-cleaner",
            root: dir("tmp-cleaner-aside"),
        });
        const asideCopy = aside.moved[0]?.stored ?? "";

        expectFresh(asideCopy);
        // The cleaner removes an empty folder by its modification time alone.
        expect(Date.now() - statSync(join(asideCopy, "empty")).mtimeMs).toBeLessThan(60_000);

        const graced = moveToTrash([{ target: resolveTarget(oldTree("trash"), base), rule: "test" }], {
            config,
            caller: AGENT,
            graceMinutes: 60,
            paths: trashPaths,
        });
        expectFresh(graced?.items[0]?.stored ?? "");

        // No grace: drained at once and promising no restore, so the move does not walk it.
        const drained = moveToTrash([{ target: resolveTarget(oldTree("trash-now"), base), rule: "test" }], {
            config,
            caller: AGENT,
            graceMinutes: 0,
            paths: trashPaths,
        });
        expectOld(drained?.items[0]?.stored ?? "");
    });

    test("the daily keepalive refreshes a pending aside and a batch in its grace, never a decided request", () => {
        const requestsDir = dir("keepalive", "requests");
        const paths: TrashPaths = {
            batchesDir: dir("keepalive", "batches"),
            lockPath: join(base, "keepalive", "drainer.lock"),
        };
        const asideRequest = (name: string) =>
            createAsideRequest({
                aside: [{ target: resolveTarget(oldTree(name), base), verdict: VERDICT }],
                inPlace: [],
                caller: AGENT,
                cwd: base,
                reason: null,
                requestsDir,
                root: dir("keepalive", "aside"),
            }).request;
        const pending = asideRequest("keepalive-pending");
        const decided = asideRequest("keepalive-decided");
        saveRmRequest({ ...decided, status: "approved", decidedAt: new Date().toISOString() }, requestsDir);
        const toTrash = (name: string, now?: Date) =>
            moveToTrash([{ target: resolveTarget(oldTree(name), base), rule: "test" }], {
                config,
                caller: AGENT,
                graceMinutes: 30,
                paths,
                now,
            });
        const inGrace = toTrash("keepalive-grace");
        const pastGrace = toTrash("keepalive-due", new Date(Date.now() - 3_600_000));
        const stored = {
            pending: pending.targets[0]?.stored ?? "",
            decided: decided.targets[0]?.stored ?? "",
            inGrace: inGrace?.items[0]?.stored ?? "",
            pastGrace: pastGrace?.items[0]?.stored ?? "",
        };

        // The moves refreshed them; three days in /tmp would age them again.
        for (const copy of Object.values(stored)) {
            age(copy);
        }

        const result = refreshWaitingRmData({ requestsDir, trashPaths: paths });

        expect(result).toMatchObject({ requests: 1, batches: 1, files: 4, failed: 0 });
        expectFresh(stored.pending);
        expectFresh(stored.inGrace);
        expectOld(stored.decided);
        expectOld(stored.pastGrace);
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

    test("the newest-entries read stops at the limit and at --since, and keeps the filter", () => {
        const path = join(dir("ledger-newest"), "ledger.jsonl");
        const codex: RmCaller = { agent: "codex", sessionId: "cdx-9", isInAgent: true };
        const now = Date.now();

        for (let i = 0; i < 6; i++) {
            const at = new Date(now - (6 - i) * 60_000).toISOString();
            appendRmLedger({ at, action: "move", path: `/x/${i}`, caller: i % 2 === 0 ? AGENT : codex }, path);
        }

        expect(readRmLedgerNewest({}, 2, path).map((e) => e.path)).toEqual(["/x/4", "/x/5"]);
        expect(readRmLedgerNewest({ agent: "codex" }, 2, path).map((e) => e.path)).toEqual(["/x/3", "/x/5"]);
        expect(readRmLedgerNewest({ since: new Date(now - 150_000) }, 50, path).map((e) => e.path)).toEqual([
            "/x/4",
            "/x/5",
        ]);
        expect(readRmLedgerNewest({}, 50, path)).toEqual(readRmLedger(path));

        // Out of order within the slack (two writers): an older line after a newer one does not hide the newer one.
        const skewed = join(dir("ledger-skewed"), "ledger.jsonl");
        appendRmLedger({ at: new Date(now - 60_000).toISOString(), action: "move", path: "/y/new" }, skewed);
        appendRmLedger({ at: new Date(now - 180_000).toISOString(), action: "move", path: "/y/old" }, skewed);
        expect(readRmLedgerNewest({ since: new Date(now - 120_000) }, 50, skewed).map((e) => e.path)).toEqual([
            "/y/new",
        ]);
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
    test("approved requests use the requester's profile and original cwd", () => {
        const requestsDir = dir("requester-profile-requests");
        const workspace = dir("requester-profile-project");
        const worker = { ...AGENT, agent: "codex" };
        const request = createRmRequest(
            { kind: "delete", caller: worker, cwd: workspace, reason: null, targets: [] },
            requestsDir
        );
        expect(approvalGraceMinutes(request, config)).toBe(240);
        const custom = {
            ...config,
            profiles: [{ name: "project", match: { cwd: workspace }, grace: { otherMinutes: 360 } }],
        };
        expect(approvalGraceMinutes(request, custom)).toBe(360);
        expect(approvalGraceMinutes({ ...request, caller: null }, custom)).toBe(config.grace.otherMinutes);
    });

    test("missing config uses defaults; unreadable or malformed policy fails closed", () => {
        const folder = dir("policy-load");
        expect(loadRmConfig(join(folder, "missing.json"))).toEqual(defaultRmConfig());
        expect(() => loadRmConfig(folder)).toThrow(/cannot read safety config/);
        const dangling = join(folder, "dangling.json");
        symlinkSync(join(folder, "missing-target"), dangling);
        expect(() => loadRmConfig(dangling)).toThrow(/cannot read safety config/);
        for (const [index, content] of [
            "{",
            "null",
            '{"protect":42}',
            '{"profiles":[{"name":"x","match":{},"allowOwnFiles":"no"}]}',
            '{"roots":[{"path":"/safe","session":false}]}',
            '{"roots":[{"path":"/safe","expiresAt":"not-a-date"}]}',
        ].entries()) {
            expect(() => loadRmConfig(file(join(folder, `invalid-${index}.json`), content))).toThrow(
                /invalid safety config/
            );
        }
        const old = loadRmConfig(file(join(folder, "old.json"), '{"protect":["/safe"],"allowOwnFiles":false}'));
        expect(old.protect).toEqual(["/safe"]);
        expect(old.allowOwnFiles).toBe(false);
        const commented = loadRmConfig(
            file(
                join(folder, "commented.json"),
                '{\n  // keep this folder\n  "protect": ["/safe",],\n  /* person only */\n  "allowOwnFiles": false,\n}\n'
            )
        );
        expect(commented.protect).toEqual(["/safe"]);
        expect(commented.allowOwnFiles).toBe(false);
        expect(() =>
            loadRmConfig(file(join(folder, "commented-bad.json"), '{\n  // a comment\n  "protect": 42,\n}\n'))
        ).toThrow(/invalid safety config/);
    });

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

describe("changing the trash root", () => {
    test("is refused while the current root holds a batch, and allowed once it is empty or unchanged", () => {
        const own = { ...config, trashRoot: join(dir("root-move"), "GenesisTools", "rm") };
        const paths = {
            batchesDir: dir("root-move-state", "batches"),
            lockPath: join(base, "root-move-state", "lock"),
        };
        const next = join(base, "elsewhere", "GenesisTools", "rm");

        expect(trashRootChangeBlocker(own, next, paths)).toBeNull();

        const target = resolveTarget(file(join(dir("root-move-src"), "a.txt")), base);
        const batch = moveToTrash([{ target, rule: "test" }], {
            config: own,
            caller: AGENT,
            graceMinutes: 60,
            paths,
            currentTrashRoot: () => own.trashRoot,
        });

        expect(trashRootChangeBlocker(own, next, paths, "tools rm drain --now")).toContain("run tools rm drain --now");
        expect(trashRootChangeBlocker(own, next, paths)).toContain("drain the trash");
        expect(trashRootChangeBlocker(own, own.trashRoot, paths)).toBeNull();

        restoreBatch(batch?.id ?? "", { config: own, paths });

        expect(trashRootChangeBlocker(own, next, paths)).toBeNull();

        // A producer's claim, held from before its first move until it publishes, counts too.
        const claim = join(paths.batchesDir, `${batch?.id ?? "x"}-next.json.restoring-${process.pid}`);
        writeFileSync(claim, "{}");

        expect(trashRootChangeBlocker(own, next, paths)).toContain("still holds 1 batch or leftover folders");
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
            currentTrashRoot: () => own.trashRoot,
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
        const aside = moveAside({
            inputs: [{ target: resolveTarget(draft, base), verdict }],
            caller: AGENT,
            batchId: "b1",
            root: asideRoot,
        });

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
});

describe("security review fixes: a typed code is not proof of a person", () => {
    const person: RmCaller = { agent: "person", sessionId: null, isInAgent: false };
    const prompt = { title: "t", lines: ["/x"], code: "delete", caller: person };

    function deps(platform: NodeJS.Platform, calls: string[]): ApprovalDeps {
        return {
            interactive: () => true,
            platform,
            typed: async () => {
                calls.push("typed");
                return true;
            },
            dialog: () => {
                calls.push("dialog");
                return false;
            },
            app: async () => ({ kind: "missing", detail: "no app" }),
        };
    }

    test("auto never takes the typed code: the macOS dialog asks, other platforms refuse", async () => {
        const calls: string[] = [];
        const mac = await confirmByPerson(prompt, deps("darwin", calls));
        const linux = await confirmByPerson(prompt, deps("linux", calls));
        const windows = await confirmByPerson(prompt, deps("win32", calls));

        expect(mac.via).toBe("dialog");
        expect(linux).toMatchObject({ approved: false, via: "none" });
        expect(linux.detail).toMatch(/"approval": "code"/);
        expect(windows.approved).toBe(false);
        expect(calls).toEqual(["dialog"]);
    });

    test("code, which the person sets, accepts the typed code outside an agent and never inside one", async () => {
        const calls: string[] = [];
        const typed = await confirmByPerson({ ...prompt, approval: "code" }, deps("linux", calls));
        const agent = await confirmByPerson({ ...prompt, approval: "code", caller: AGENT }, deps("linux", calls));

        expect(typed).toMatchObject({ approved: true, via: "tty" });
        expect(agent.approved).toBe(false);
        expect(calls).toEqual(["typed"]);
    });
});

describe("crash safety: the record comes before the move", () => {
    let crashConfig: RmConfig;
    let crashPaths: TrashPaths;

    beforeAll(() => {
        crashConfig = { ...config, trashRoot: join(base, "crash", "GenesisTools", "rm") };
        crashPaths = { batchesDir: join(base, "crash-state", "batches"), lockPath: join(base, "crash-state", "lock") };
    });

    /** Runs `body` in a child bun that SIGKILLs itself in the second `beforeRename`: a crash, no finally runs. */
    function crashOnSecondMove(body: string, args: string[]): number {
        const script = file(
            join(dir("crash-scripts"), `${Bun.hash(body).toString(16)}.ts`),
            [
                `import * as rm from ${SafeJSON.stringify(join(import.meta.dir, "index.ts"))};`,
                "let renames = 0;",
                "const hooks = { beforeRename: () => { renames++; if (renames === 2) process.kill(process.pid, 'SIGKILL'); } };",
                "const args = process.argv.slice(2);",
                body,
            ].join("\n")
        );
        const proc = Bun.spawnSync([process.execPath, script, ...args], { env: process.env, stderr: "pipe" });

        expect(proc.signalCode).toBe("SIGKILL");
        return proc.pid;
    }

    test("a crash between moves keeps every file: no drain, the sweep keeps the folder, restore brings it back", async () => {
        const first = file(join(dir("crash-trash"), "first.txt"), "one");
        const second = file(join(dir("crash-trash"), "second.txt"), "two");
        const pid = crashOnSecondMove(
            [
                "const [config, paths, ...targets] = args;",
                "rm.moveToTrash(targets.map((path) => ({ target: rm.resolveTarget(path, '/'), rule: 'test' })), {",
                "    config: JSON.parse(config), caller: null, graceMinutes: 0, paths: JSON.parse(paths), hooks,",
                "    currentTrashRoot: () => JSON.parse(config).trashRoot,",
                "});",
            ].join("\n"),
            [SafeJSON.stringify(crashConfig), SafeJSON.stringify(crashPaths), first, second]
        );

        expect(existsSync(first)).toBe(false);
        expect(existsSync(second)).toBe(true);
        const claim = readdirSync(crashPaths.batchesDir).find((name) => name.endsWith(`.json.restoring-${pid}`));
        const id = claim?.split(".json.")[0] ?? "";

        expect(id).not.toBe("");
        expect(listBatches(crashPaths)).toEqual([]);
        expect((await drainDue({ config: crashConfig, paths: crashPaths, force: true })).items).toBe(0);

        const swept = await sweepOrphans({ config: crashConfig, paths: crashPaths, minAgeMs: 0 });
        const record = SafeJSON.parse(readFileSync(join(crashPaths.batchesDir, `${id}.json`), "utf8"));

        expect(swept.batches).toBe(0);
        expect(swept.held.map((entry) => entry.id)).toEqual([id]);
        // An older reader drains and restores `items`; the incomplete record has none, so it reads no batch.
        expect(record.items).toBeUndefined();
        expect(record.planned.map((item: { original: string }) => item.original)).toEqual([first, second]);
        expect(listBatches(crashPaths).map((batch) => [batch.id, batch.incomplete])).toEqual([[id, true]]);
        expect((await drainDue({ config: crashConfig, paths: crashPaths, force: true })).items).toBe(0);
        expect(existsSync(join(crashConfig.trashRoot, id))).toBe(true);

        const restored = restoreBatch(id, { config: crashConfig, paths: crashPaths });

        expect(restored).toEqual({ restored: [first], skipped: [], notMoved: [second] });
        expect(readFileSync(first, "utf8")).toBe("one");
        expect(readFileSync(second, "utf8")).toBe("two");
        expect(listBatches(crashPaths)).toEqual([]);
    });

    test("while the producer moves, the drain sees nothing, the sweep keeps the folder and a restore refuses", async () => {
        const first = file(join(dir("live-trash"), "first.txt"), "one");
        const second = file(join(dir("live-trash"), "second.txt"), "two");
        const running: Array<Promise<unknown>> = [];
        let renames = 0;
        let refusal = "";
        const batch = moveToTrash(
            [first, second].map((path) => ({ target: resolveTarget(path, base), rule: "test" })),
            {
                config: crashConfig,
                caller: null,
                graceMinutes: 0,
                paths: crashPaths,
                currentTrashRoot: () => crashConfig.trashRoot,
                hooks: {
                    beforeRename: () => {
                        renames++;

                        if (renames !== 2) {
                            return;
                        }

                        const id = readdirSync(crashPaths.batchesDir)
                            .find((name) => name.endsWith(`.json.restoring-${process.pid}`))
                            ?.split(".json.")[0];

                        running.push(drainDue({ config: crashConfig, paths: crashPaths, force: true }));
                        running.push(sweepOrphans({ config: crashConfig, paths: crashPaths, minAgeMs: 0 }));
                        try {
                            restoreBatch(id ?? "", { config: crashConfig, paths: crashPaths });
                        } catch (error) {
                            refusal = error instanceof Error ? error.message : String(error);
                        }
                    },
                },
            }
        );
        const [drained, swept] = await Promise.all(running);

        expect(drained).toMatchObject({ items: 0 });
        expect(swept).toMatchObject({ batches: 0, held: [{ id: batch?.id }] });
        expect(refusal).toMatch(/still moving/);
        expect(batch?.items.map((item) => item.original)).toEqual([first, second]);
        expect(batch?.items.every((item) => existsSync(item.stored))).toBe(true);
        expect(readdirSync(crashPaths.batchesDir)).toEqual([`${batch?.id}.json`]);
        expect(restoreBatch(batch?.id ?? "", { config: crashConfig, paths: crashPaths }).restored).toEqual([
            first,
            second,
        ]);
    });

    test("an aside run that crashes between moves keeps its folder guarded; recovery opens the request, deny puts all back", () => {
        const requestsDir = dir("crash-aside-requests");
        const asideRoot = dir("cc", "proj", "sess-1111", "rm-aside");
        const first = file(join(dir("crash-aside"), "first.md"), "one");
        const second = file(join(dir("crash-aside"), "second.md"), "two");
        const pid = crashOnSecondMove(
            [
                "const [requestsDir, root, ...targets] = args;",
                "const verdict = { kind: 'ask', rule: 'git-tracked', reason: 'tracked' };",
                "rm.createAsideRequest({",
                "    aside: targets.map((path) => ({ target: rm.resolveTarget(path, '/'), verdict })),",
                "    inPlace: [],",
                "    caller: { agent: 'claude-code', sessionId: 'sess-1111', isInAgent: true },",
                "    cwd: '/', reason: null, requestsDir, root, hooks,",
                "});",
            ].join("\n"),
            [requestsDir, asideRoot, first, second]
        );

        expect(existsSync(first)).toBe(false);
        expect(existsSync(second)).toBe(true);
        // No reader, an older one included, lists the journal as a request: nobody can decide it mid-move.
        expect(listRmRequests({ dir: requestsDir })).toEqual([]);
        const journal = readdirSync(requestsDir).find((name) => name.endsWith(`.json.moving-${pid}`)) ?? "";
        const id = journal.split(".json.")[0];
        const pending = pendingAsideDirs(requestsDir);
        const c = ctx({ asidePending: (t) => pendingAsideFor(t.canonical, pending) });

        expect(pending.map((entry) => entry.requestId)).toEqual([id]);
        expect(verdictOf(asideRoot, c)).toEqual({ kind: "deny", rule: "aside-pending" });

        expect(recoverAsideJournals(requestsDir)).toEqual([id]);
        const request = loadRmRequest(id, requestsDir);

        expect(readdirSync(requestsDir)).toEqual([`${id}.json`]);
        expect(request?.status).toBe("pending");
        expect(request?.targets.map((t) => [t.path, t.stored !== undefined])).toEqual([
            [first, true],
            [second, false],
        ]);

        if (!request) {
            throw new Error(`no recovered request ${id}`);
        }

        // The recovered copy goes home and the never-moved path stays: a deny (`denyRequest`) runs this put-back.
        const back = returnAside(request.targets, AGENT, request.id);

        expect(back.returned).toEqual([first]);
        expect(back.kept).toEqual([]);
        expect(readFileSync(first, "utf8")).toBe("one");
        expect(readFileSync(second, "utf8")).toBe("two");
    });

    test("a finished aside run leaves only its request, and its journal named every move before the first", () => {
        const requestsDir = dir("live-aside-requests");
        const src = file(join(dir("live-aside"), "draft.md"), "work");
        const seen: string[][] = [];
        const { request, aside } = createAsideRequest({
            aside: [
                { target: resolveTarget(src, base), verdict: { kind: "ask", rule: "git-tracked", reason: "tracked" } },
            ],
            inPlace: [],
            caller: AGENT,
            cwd: base,
            reason: null,
            requestsDir,
            root: dir("cc", "proj", "sess-1111", "rm-aside"),
            hooks: { beforeRename: () => seen.push(readdirSync(requestsDir)) },
        });

        expect(seen).toEqual([[`${request.id}.json.moving-${process.pid}`]]);
        expect(readdirSync(requestsDir)).toEqual([`${request.id}.json`]);
        expect(request.targets.map((t) => t.stored)).toEqual(aside?.moved.map((t) => t.stored) ?? []);
        expect(request.asideDir).toBe(aside?.dir);
        expect(recoverAsideJournals(requestsDir)).toEqual([]);
    });
});

describe("measureBytesAsync", () => {
    test("gives the event loop a turn in a tree of empty folders, and counts what measureBytes counts", async () => {
        const root = dir("measure-empty-folders");

        for (let index = 0; index < 2500; index++) {
            mkdirSync(join(root, `d${index}`));
        }

        file(join(root, "d7", "only.bin"), "abc");
        let turned = false;
        setImmediate(() => {
            turned = true;
        });
        // The callback can only run before the walk ends when the walk gave the event loop a turn.
        const measured = await measureBytesAsync(root).then((bytes) => ({ bytes, turned }));

        expect(measured.turned).toBe(true);
        expect(measured.bytes).toBe(measureBytes(root));
        expect(measured.bytes).toBeGreaterThan(0);
    });
});

describe("printApprovalUpdates", () => {
    test("the typed code stops waiting for sizes at its deadline instead of holding the prompt", async () => {
        const updates = new ApprovalUpdates();
        updates.push({ path: "/work/shop/out", bytes: 4096, measuring: false });

        // The second row's walk never ends, and nothing closes the updates.
        expect(await printApprovalUpdates(updates, { timeoutMs: 30 })).toBe("timeout");
    });

    test("it ends at once when every size is in", async () => {
        const updates = new ApprovalUpdates();
        updates.push({ path: "/work/shop/out", bytes: 4096, measuring: false });
        updates.close();

        expect(await printApprovalUpdates(updates, { timeoutMs: 60_000 })).toBe("complete");
    });
});

describe("a tree with a folder that cannot be read", () => {
    test("has no size, so a partial sum is never shown or saved as the whole", async () => {
        const root = dir("measure-unreadable");
        file(join(root, "readable.bin"), "abc");
        const locked = dir("measure-unreadable", "locked");
        file(join(locked, "hidden.bin"), "abcdef");
        chmodSync(locked, 0o000);

        try {
            expect(await measureBytesAsync(root)).toBeNull();
            expect(await measureTarget({ path: root })).toBeNull();
        } finally {
            chmodSync(locked, 0o755);
        }

        expect(await measureBytesAsync(root)).toBeGreaterThan(0);
    });
});

describe("measurements written by two processes at once", () => {
    test("keep every path's entry, and log an aside copy's size once", async () => {
        const requestsDir = dir("concurrent-requests");
        const script = file(
            join(dir("concurrent-scripts"), "writer.ts"),
            [
                `import * as rm from ${SafeJSON.stringify(join(import.meta.dir, "index.ts"))};`,
                "const [requestsDir, writer] = process.argv.slice(2);",
                "const request = { id: 'conc01', caller: null };",
                "for (let index = 0; index < 150; index++) {",
                "    const own = `/w/${writer}-${index}`;",
                "    const item = { path: own, location: own, at: '', mtimeMs: 1, bytes: index };",
                "    rm.recordRmMeasurement({ request, target: { path: own }, item, requestsDir });",
                "    const stored = `/aside/${index % 30}`;",
                "    const copy = { path: `/w/shared-${index % 30}`, location: stored, at: '', mtimeMs: 1, bytes: 7 };",
                "    rm.recordRmMeasurement({ request, target: { path: copy.path, stored }, item: copy, requestsDir });",
                "}",
            ].join("\n")
        );
        const writers = ["a", "b"].map((writer) =>
            Bun.spawn([process.execPath, script, requestsDir, writer], { env: process.env, stderr: "pipe" })
        );

        expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0]);

        const saved = loadRmMeasurements("conc01", requestsDir)?.items ?? [];
        expect(saved.filter((item) => item.path.startsWith("/w/a-") || item.path.startsWith("/w/b-"))).toHaveLength(
            300
        );
        expect(saved.filter((item) => item.location.startsWith("/aside/"))).toHaveLength(30);
        expect(
            readRmLedger().filter((entry) => entry.action === "measure" && entry.requestId === "conc01")
        ).toHaveLength(30);
    });
});

describe("the ledger claim of an aside copy's size", () => {
    test("an empty marker is a claim in progress, and only an old empty marker is taken over", () => {
        const requestsDir = dir("claim-requests");
        const request = { id: "emp001", caller: AGENT };
        const target = { path: "/work/shop/claim", stored: "/aside/claim" };
        const item = { path: target.path, location: target.stored, at: "", mtimeMs: 1, bytes: 9 };
        const lines = () => readRmLedger().filter((entry) => entry.requestId === "emp001").length;
        recordRmMeasurement({ request, target, item, requestsDir });
        const measurements = join(rmMeasurementsDir(requestsDir), "emp001");
        const marker = join(measurements, readdirSync(measurements).find((name) => name.endsWith(".ledger")) ?? "x");

        expect(lines()).toBe(1);

        // Another process opened the marker with O_EXCL and has not written its pid yet.
        writeFileSync(marker, "");
        recordRmMeasurement({ request, target, item, requestsDir });
        expect(lines()).toBe(1);

        // An empty marker that old belongs to a process that died between the open and the write.
        const old = new Date(Date.now() - 60_000);
        utimesSync(marker, old, old);
        recordRmMeasurement({ request, target, item, requestsDir });
        expect(lines()).toBe(2);
    });
});

describe("a single-holder lock (the drainer, a request's decision, a measurement pass)", () => {
    test("an empty lock is a holder between its create and its pid write; only an old empty lock is taken over", () => {
        const requestsDir = dir("empty-lock-requests");
        const lockPath = rmRequestLockFile("emplk1", requestsDir);
        writeFileSync(lockPath, "");

        expect(acquireDrainerLock(lockPath)).toBeNull();
        expect(lockRmRequest("emplk1", requestsDir)).toEqual({ ok: false, holder: null });
        expect(readFileSync(lockPath, "utf8")).toBe("");

        // An empty lock that old belongs to a process that died between the create and the write.
        const old = new Date(Date.now() - 60_000);
        utimesSync(lockPath, old, old);
        const release = acquireDrainerLock(lockPath);

        expect(release).not.toBeNull();
        expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
        release?.();
        expect(existsSync(lockPath)).toBe(false);
    });

    test("a takeover never removes a lock that changed hands after it was read", () => {
        const lockPath = join(dir("changed-lock"), "drainer.lock");
        // Read as the dead holder 999999; a live process (this test's parent) took the lock over since.
        writeFileSync(lockPath, String(process.ppid));

        expect(removeStaleLock(lockPath, "999999")).toBe(false);
        expect(readFileSync(lockPath, "utf8")).toBe(String(process.ppid));

        // Still the dead holder's: the name is freed.
        writeFileSync(lockPath, "999999");
        expect(removeStaleLock(lockPath, "999999")).toBe(true);
        expect(existsSync(lockPath)).toBe(false);
    });

    test("processes that start on a dead holder's lock at once end with one holder", async () => {
        const lockPath = join(dir("raced-lock"), "decision.lock");
        writeFileSync(lockPath, "999999");
        const script = file(
            join(dir("raced-lock-scripts"), "racer.ts"),
            [
                `import * as rm from ${SafeJSON.stringify(join(import.meta.dir, "index.ts"))};`,
                "const [lockPath, startAt] = process.argv.slice(2);",
                "await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));",
                "process.stdout.write(rm.acquireDrainerLock(lockPath) ? 'won' : 'lost');",
                // A winner stays alive until the test closes stdin: a racer that started late under load would
                // otherwise find the winner already exited and take its lock over, rightly, as a dead holder's.
                "for await (const _ of Bun.stdin.stream()) {}",
            ].join("\n")
        );
        const startAt = String(Date.now() + 700);
        const racers = [1, 2, 3, 4].map(() =>
            Bun.spawn([process.execPath, script, lockPath, startAt], {
                env: process.env,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
            })
        );
        const said = await Promise.all(
            racers.map(async (racer) => {
                const { value } = await racer.stdout.getReader().read();

                return new TextDecoder().decode(value);
            })
        );

        for (const racer of racers) {
            racer.stdin.end();
        }

        expect(await Promise.all(racers.map((racer) => racer.exited))).toEqual([0, 0, 0, 0]);
        expect(said.filter((word) => word === "won")).toHaveLength(1);
    });
});

describe("a request path under a parent that became a file", () => {
    test("reads as gone, and a folder that may not be read still throws", () => {
        const parent = file(join(dir("enotdir"), "example"));
        const child = join(parent, "child");
        const request: RmRequest = {
            id: "ntdr01",
            kind: "delete",
            createdAt: new Date().toISOString(),
            caller: AGENT,
            cwd: base,
            reason: null,
            status: "pending",
            targets: [{ path: child, kind: "file", rule: "default", reason: "no rule allows it" }],
        };

        expect(pathPresent(child)).toBe(false);
        expect(requestLive(request).state).toBe("gone");
        expect(pathPresent(parent)).toBe(true);

        const locked = dir("enotdir-locked");
        file(join(locked, "inner", "x.txt"));
        chmodSync(locked, 0o000);

        try {
            expect(() => pathPresent(join(locked, "inner"))).toThrow();
        } finally {
            chmodSync(locked, 0o755);
        }
    });
});

describe("the size of an aside copy in the ledger", () => {
    test("is counted under the rule that set the copy aside", () => {
        const request = { id: "rule01", caller: AGENT };
        const target = { path: "/work/shop/notes", stored: "/aside/notes", rule: "git-untracked" };
        const item = { path: target.path, location: target.stored, at: "", mtimeMs: 1, bytes: 5000 };
        recordRmMeasurement({ request, target, item, requestsDir: dir("rule-requests") });
        const totals = totalRmLedger(
            readRmLedger().filter((entry) => entry.requestId === "rule01"),
            "rule"
        );

        expect(totals).toEqual([expect.objectContaining({ key: "git-untracked", aside: 5000 })]);
    });
});

describe("an aside size whose ledger line could not be written", () => {
    test("is written by the next measurement pass, once, though the size is still fresh", async () => {
        const requestsDir = dir("ledger-retry-requests");
        const stored = file(join(dir("ledger-retry-aside"), "notes.md"), "kept for the user");
        const target = {
            path: "/work/shop/notes.md",
            kind: "file" as const,
            rule: "git-untracked",
            reason: "r",
            stored,
        };
        const request = createRmRequest(
            { kind: "delete", caller: AGENT, cwd: base, reason: null, targets: [target] },
            requestsDir
        );
        const lines = () =>
            readRmLedger().filter((entry) => entry.action === "measure" && entry.requestId === request.id);
        const ledger = rmLedgerPath();
        appendRmLedger({ action: "request", requestId: "warm-up" });
        chmodSync(ledger, 0o444);

        try {
            const item = await measureTarget(target);

            if (!item) {
                throw new Error("the aside copy was not measured");
            }

            recordRmMeasurement({ request, target, item, requestsDir });
        } finally {
            chmodSync(ledger, 0o644);
        }

        expect(lines()).toHaveLength(0);
        expect(await measureRmRequest(request.id, { requestsDir })).toMatchObject({ fresh: 1, measured: 0 });
        expect(lines()).toHaveLength(1);
        await measureRmRequest(request.id, { requestsDir });
        expect(lines()).toHaveLength(1);
    });
});

describe("a measurement pass over many paths", () => {
    test("reads each path's own saved file, not every file once per path", async () => {
        const requestsDir = dir("many-paths-requests");
        const folder = dir("many-paths");
        const targets = Array.from({ length: 20 }, (_, index) => ({
            path: file(join(folder, `f${index}.txt`)),
            kind: "file" as const,
            rule: "default",
            reason: "r",
        }));
        const request = createRmRequest(
            { kind: "delete", caller: AGENT, cwd: base, reason: null, targets },
            requestsDir
        );
        expect(await measureRmRequest(request.id, { requestsDir })).toMatchObject({ measured: 20 });
        const reads = spyOn(fs, "readFileSync");

        try {
            expect(await measureRmRequest(request.id, { requestsDir })).toMatchObject({ fresh: 20 });
            const saved = reads.mock.calls.filter(([path]) => /\/measured\/.+\.json$/.test(String(path)));
            expect(saved).toHaveLength(20);
        } finally {
            reads.mockRestore();
        }
    });
});

describe("the git facts of a big request", () => {
    test("run at most `concurrency` git processes at once, across every path", async () => {
        const repo = dir("git-bound-repo");
        git(repo, "init", "-q");
        const paths = Array.from({ length: 40 }, (_, index) => file(join(repo, `f${index}.txt`)));
        let running = 0;
        let most = 0;
        let calls = 0;
        const facts = await probeItemGit(
            paths.map((path) => ({ path })),
            {
                concurrency: 4,
                git: async () => {
                    calls++;
                    running++;
                    most = Math.max(most, running);
                    await Bun.sleep(2);
                    running--;
                    return "";
                },
            }
        );

        // One status for the repository, one log per path.
        expect(calls).toBe(41);
        expect(most).toBeLessThanOrEqual(4);
        expect(facts.size).toBe(40);
    });
});

describe("prune", () => {
    test("closes gone and expired requests, keeps aside, lost and busy ones, and moves no file", () => {
        const root = mkdtempSync(join(tmpdir(), "gt-rm-prune-"));
        const dir = join(root, "requests");
        const here = join(root, "files");
        mkdirSync(join(here, "aside"), { recursive: true });
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(here, "kept.txt"), "x");
        writeFileSync(join(here, "aside", "copy.txt"), "x");
        const fields = { kind: "delete" as const, caller: null, cwd: here, reason: null, status: "pending" as const };
        const target = (path: string, stored?: string) => ({
            path: join(here, path),
            kind: "file" as const,
            rule: "default",
            reason: "r",
            ...(stored ? { stored: join(here, stored) } : {}),
        });
        saveRmRequest(
            { ...fields, id: "gone11", createdAt: "2026-11-01T13:00:00.000Z", targets: [target("missing.txt")] },
            dir
        );
        saveRmRequest(
            { ...fields, id: "expd22", createdAt: "2026-10-30T13:00:00.000Z", targets: [target("kept.txt")] },
            dir
        );
        saveRmRequest(
            {
                ...fields,
                id: "asid33",
                createdAt: "2026-10-27T13:00:00.000Z",
                targets: [target("orig.txt", "aside/copy.txt")],
            },
            dir
        );
        saveRmRequest(
            {
                ...fields,
                id: "lost44",
                createdAt: "2026-10-27T13:00:00.000Z",
                targets: [target("orig2.txt", "aside/nope.txt")],
            },
            dir
        );
        saveRmRequest(
            { ...fields, id: "busy55", createdAt: "2026-11-01T13:00:00.000Z", targets: [target("missing2.txt")] },
            dir
        );
        writeFileSync(rmRequestLockFile("busy55", dir), String(process.ppid));
        const now = new Date("2026-11-01T14:00:00.000Z");

        expect(pruneRmRequests({ dir, now, dryRun: true }).closed.map((c) => c.id)).toEqual([
            "busy55",
            "expd22",
            "gone11",
        ]);
        const result = pruneRmRequests({ dir, now });
        expect(result.closed).toEqual([
            { id: "expd22", status: "expired" },
            { id: "gone11", status: "gone" },
        ]);
        expect(result.busy).toEqual(["busy55"]);
        const status = (id: string) => readRmRequestFile(join(dir, `${id}.json`))?.status;
        expect(["gone11", "expd22", "asid33", "lost44", "busy55"].map(status)).toEqual([
            "gone",
            "expired",
            "pending",
            "pending",
            "pending",
        ]);
        expect(existsSync(join(here, "kept.txt")) && existsSync(join(here, "aside", "copy.txt"))).toBe(true);
    });
});

describe("a refusal after the wait names what happened", () => {
    test("a path moved away since the check is gone now, and a new file there is another file", () => {
        const path = file(join(dir("gone-now"), "a.txt"));
        const pinned = resolveTarget(path, base);
        renameSync(path, `${path}.moved`);

        expect(targetChangeReason(pinned)).toBe("it is gone now (moved or deleted since the check)");

        file(path, "new");
        expect(targetChangeReason(pinned)).toBe("another file or folder is there now");
    });
});

describe("the macOS dialog never hides a path", () => {
    function dialogDeps(calls: string[]): ApprovalDeps {
        return {
            interactive: () => false,
            platform: "darwin",
            typed: async () => true,
            dialog: () => {
                calls.push("dialog");
                return true;
            },
            app: async () => ({ kind: "missing", detail: "unavailable" }),
        };
    }

    const lines = (count: number) => Array.from({ length: count }, (_, index) => `/work/shop/file-${index}.txt`);

    test("a prompt longer than the dialog shows is refused, and the dialog never opens", async () => {
        const calls: string[] = [];
        const outcome = await confirmByPerson(
            { title: "t", lines: lines(16), code: "abc", caller: AGENT },
            dialogDeps(calls)
        );

        expect(outcome.approved).toBe(false);
        expect(outcome.detail).toContain("15 lines");
        expect(calls).toEqual([]);
    });

    test("a prompt that fits still asks with the dialog", async () => {
        const calls: string[] = [];
        const outcome = await confirmByPerson(
            { title: "t", lines: lines(15), code: "abc", caller: AGENT },
            dialogDeps(calls)
        );

        expect(outcome).toMatchObject({ approved: true, via: "dialog" });
        expect(calls).toEqual(["dialog"]);
    });
});

describe("the ledger names a person's check apart from the shell that ran it", () => {
    test("an approve a person confirmed from an agent's shell counts under person", () => {
        const at = "2026-11-01T12:00:00.000Z";
        const entries: RmLedgerEntry[] = [
            { at, action: "approve", requestId: "dvzu7k", caller: AGENT, via: "touch-id", person: { via: "touch-id" } },
            { at, action: "move", caller: AGENT, bytes: 10, path: "/work/shop/dist" },
        ];

        expect(entries.map(ledgerAgent)).toEqual(["person", "claude-code"]);
        expect(
            totalRmLedger(entries, "agent")
                .map((total) => total.key)
                .sort()
        ).toEqual(["claude-code", "person"]);
        expect(filterRmLedger(entries, { agent: "person" }).map((entry) => entry.action)).toEqual(["approve"]);
    });

    test("a person at a plain shell counts as person, never under the operating-system account", () => {
        const shell = { agent: "unknown", sessionId: null, isInAgent: false, user: "alice" };
        const entries: RmLedgerEntry[] = [{ at: "2026-11-01T12:00:00.000Z", action: "restore", caller: shell }];

        expect(totalRmLedger(entries, "agent").map((total) => total.key)).toEqual(["person"]);
    });
});

describe("the default rule says what nearly matched", () => {
    const reasonOf = (path: string, context = ctx()) => evaluateTarget(resolveTarget(path, context.cwd), context);
    const generic = "no rule allows it: a preset, this session's scratch or own files, or a trusted root";

    test("a scratch folder named with a short session id asks for the full id", () => {
        const verdict = reasonOf(file(join(dir("cc", "proj", "sess"), "a.txt")));
        expect(verdict).toMatchObject({ kind: "ask", rule: "default" });
        expect(verdict.reason).toBe(
            `the scratch folder must use the full session id: ${join(base, "cc", "proj", "sess-1111")}/`
        );
    });

    test("another session's scratch names that session", () => {
        const other = "bbbbbbbb-2222-4222-8222-222222222222";
        expect(reasonOf(file(join(dir("cc", "proj", other), "a.txt"))).reason).toBe(
            "another session's scratch (bbbbbbbb): only that session deletes there without asking"
        );
    });

    test("a project folder in scratch with no session level says where scratch goes", () => {
        expect(reasonOf(file(join(dir("cc", "proj", "notes"), "a.txt"))).reason).toBe(
            `no session folder: write scratch to ${join(base, "cc", "proj", "sess-1111")}/`
        );
    });

    test("a loose file directly in the temp folder says where scratch goes next time", () => {
        const loose = join(realpathSync(tmpdir()), `gt-rm-loose-${process.pid}.json`);
        writeFileSync(loose, "{}");

        try {
            expect(reasonOf(loose).reason).toBe(
                `a loose temp file: write scratch to ${dirname(asideRootFor(AGENT))}/ next time`
            );
        } finally {
            unlinkSync(loose);
        }
    });

    test("an opt-in preset that is off is named with the command that turns it on", () => {
        const within = dir("shop-cache");
        const withPreset: RmConfig = {
            ...config,
            customPresets: [{ id: "shop-cache", description: "a shop cache", names: [], within, optIn: true }],
        };
        const context = ctx({
            config: withPreset,
            presets: presetsFor(withPreset),
            hints: { enablePreset: (id) => `tools rm config set enable-preset ${id}` },
        });
        const verdict = reasonOf(dir("shop-cache", "v1"), context);
        expect(verdict.reason).toBe(
            "matches the opt-in preset shop-cache, which is off; the user can turn it on: tools rm config set enable-preset shop-cache"
        );
        // A copy of the util in another repo gets no hint, so its reason names no command.
        expect(reasonOf(dir("shop-cache", "v1"), { ...context, hints: undefined }).reason).toBe(
            "matches the opt-in preset shop-cache, which is off; the user can turn it on"
        );
        // A live cache another install may read stays where it is while it waits.
        expect(verdict.stayInPlace).toBe("a live cache: another install may read it");
        expect(reasonOf(dir("elsewhere", "plain"), context).stayInPlace).toBeUndefined();
    });

    test("a file the session did not write with its own tools says what counts as its own", () => {
        expect(reasonOf(file(join(dir("elsewhere"), "built.bin"))).reason).toBe(
            "only files written with the Write, Edit or NotebookEdit tool count as this session's own files"
        );
    });

    test("anything else keeps the general sentence", () => {
        expect(reasonOf(dir("elsewhere", "folder")).reason).toBe(generic);
        expect(
            reasonOf(file(join(dir("elsewhere"), "p.txt")), ctx({ caller: { ...AGENT, isInAgent: false } })).reason
        ).toBe(generic);
    });
});

describe("the SessionStart hook names the scratch folder tools rm uses", () => {
    test("the hook's copy of the path builder names the same folder as asideRootFor", () => {
        const sessionId = "aaaaaaaa-1111-4111-8111-111111111111";
        const cases: Array<{ harness: "claude" | "codex" | "grok"; agent: string; project: string | null }> = [
            { harness: "claude", agent: "claude-code", project: "shop" },
            { harness: "codex", agent: "codex", project: "my shop!" },
            { harness: "grok", agent: "grok", project: null },
        ];

        for (const { harness, agent, project } of cases) {
            expect(sessionScratchPath({ harness, project, sessionId })).toBe(
                dirname(asideRootFor({ agent, sessionId, isInAgent: true, project }))
            );
        }
    });
});

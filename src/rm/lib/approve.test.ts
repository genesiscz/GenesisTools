import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli";
import {
    type ApprovalItemUpdate,
    createRmRequest,
    defaultRmConfig,
    defaultRuleContext,
    drainDue,
    isRootActive,
    listRmRequests,
    loadRmConfig,
    loadRmMeasurements,
    loadRmRequest,
    measureRmRequest,
    moveAside,
    moveToTrash,
    newBatchId,
    pendingAsideDirs,
    presetsFor,
    priorDenials,
    type RmCaller,
    type RmConfig,
    type RmRequest,
    resolveTarget,
    restoreBatch,
    rmRequestLockFile,
    saveRmConfig,
    saveRmRequest,
    stillAside,
    updateRmRequest,
} from "@genesiscz/utils/rm";
import { stripAnsi } from "@genesiscz/utils/string";
import { type Command, CommanderError } from "commander";
import { saveApproved, underDecisionLock } from "../commands/requests";
import { applyRmSetting, saveRmSetting } from "../commands/settings";
import { createRmProgram } from "../program";
import {
    type ApprovalRowDeps,
    type ApproveEntry,
    approvalRows,
    approveDelete,
    denyRequest,
    splitBySelection,
} from "./approve";
import { shortRmPath } from "./display";
import { buildRequestViews, renderRequestDetail, renderRequestList } from "./requests-view";
import { executePlan, type RunContext } from "./run";

const AGENT: RmCaller = { agent: "claude-code", sessionId: "sess-2222", isInAgent: true };
const PERSON: RmCaller = { agent: "person", sessionId: null, isInAgent: false };

let base: string;
let config: RmConfig;

function file(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    return path;
}

function context(): RunContext {
    return {
        config,
        base: config,
        profiles: [],
        caller: PERSON,
        cwd: base,
        rules: defaultRuleContext(config, PERSON, base),
    };
}

/** Two files moved aside into a pending request, as `tools rm` leaves them for the person. */
function asideRequest(folder: string): RmRequest {
    const paths = [file(join(base, folder, "a.txt")), file(join(base, folder, "b.txt"))];
    const verdict = { kind: "ask" as const, rule: "default", reason: "no rule allows it" };
    const aside = moveAside({
        inputs: paths.map((path) => ({ target: resolveTarget(path, base), verdict })),
        caller: AGENT,
        batchId: newBatchId(),
        root: join(base, "aside", folder),
    });
    return createRmRequest({
        kind: "delete",
        caller: AGENT,
        cwd: join(base, folder),
        reason: "cleanup",
        targets: aside.moved,
        asideDir: aside.dir,
    });
}

function entriesOf(request: RmRequest): ApproveEntry[] {
    return request.targets.map((wanted) => ({
        wanted,
        target: resolveTarget(wanted.stored ?? wanted.path, request.cwd),
    }));
}

beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gt-rm-approve-")));
    config = { ...defaultRmConfig(), trashRoot: join(base, "GenesisTools", "rm") };
    saveRmConfig(config);
});

afterAll(async () => {
    await drainDue({ config, force: true });
});

describe("approve in the window", () => {
    test("only the ticked aside copy goes to trash; a twin request remains pending", () => {
        const request = asideRequest("work");
        const [a, b] = request.targets.map((target) => target.path);
        const twin = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: join(base, "work"),
            reason: null,
            targets: [{ path: a ?? "", kind: "file", rule: "default", reason: "asked again" }],
        });
        const { approved, denied } = splitBySelection(entriesOf(request), [a ?? ""]);
        const before = Date.now();
        const { batch } = approveDelete({
            ctx: context(),
            request,
            approved,
            denied,
            choices: { selected: [a ?? ""], disposal: "trash", remember: "session", note: null },
        });

        expect(batch?.items.map((item) => item.original)).toEqual([a ?? ""]);
        expect(Date.parse(batch?.drainAfter ?? "") - before).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
        expect(existsSync(a ?? "")).toBe(false);
        expect(existsSync(b ?? "")).toBe(true);
        expect(loadRmRequest(twin.id)).toMatchObject({ status: "pending" });

        const root = loadRmConfig().roots.find((r) => r.path === join(base, "work"));

        expect(root).toMatchObject({ session: "sess-2222", via: `request:${request.id}` });
        expect(root && isRootActive(root, "sess-2222")).toBe(true);
        expect(root && isRootActive(root, "sess-other")).toBe(false);
    });

    test("approval leaves a recreated original and a separate aside copy untouched", () => {
        const request = asideRequest("replacement");
        const original = request.targets[0]?.path ?? "";
        const other = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: request.cwd,
            reason: null,
            targets: [{ path: original, kind: "file", rule: "default", reason: "older request" }],
        });
        const otherCopy = file(join(base, "other-copy", "a.txt"));
        const asideTwin = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: request.cwd,
            reason: null,
            targets: [{ path: original, stored: otherCopy, kind: "file", rule: "default", reason: "another copy" }],
            asideDir: join(base, "other-copy"),
        });
        file(original);
        const { approved, denied } = splitBySelection(entriesOf(request), [original]);
        const { batch } = approveDelete({
            ctx: context(),
            request,
            approved,
            denied,
            choices: { selected: [original], disposal: "permanent", remember: "once", note: null },
        });
        expect(batch?.items).toHaveLength(1);
        expect(existsSync(original)).toBe(true);
        expect(existsSync(otherCopy)).toBe(true);
        expect(loadRmRequest(other.id)?.status).toBe("pending");
        expect(loadRmRequest(asideTwin.id)?.status).toBe("pending");
    });

    test("duplicate in-place requests share the approved object", () => {
        const path = file(join(base, "in-place", "a.txt"));
        const target = { path, kind: "file" as const, rule: "default", reason: "asked again" };
        const input = { kind: "delete" as const, caller: AGENT, cwd: base, reason: null, targets: [target] };
        const request = createRmRequest(input);
        const twin = createRmRequest(input);
        const stored = file(join(base, "in-place-other-copy", "a.txt"));
        const asideTwin = createRmRequest({
            ...input,
            targets: [{ ...target, stored }],
            asideDir: join(base, "in-place-other-copy"),
        });
        const { batch } = approveDelete({
            ctx: context(),
            request,
            approved: entriesOf(request),
            denied: [],
            choices: { selected: null, disposal: "trash", remember: "once", note: null },
        });
        expect(batch?.items).toHaveLength(1);
        expect(loadRmRequest(twin.id)).toMatchObject({ status: "approved", batchId: batch?.id });
        expect(existsSync(stored)).toBe(true);
        expect(loadRmRequest(asideTwin.id)?.status).toBe("pending");
    });

    test("an initially blocked aside item remains pending after another item is approved", () => {
        const request = asideRequest("initially-blocked");
        const entries = entriesOf(request);
        const blocked = entries.slice(0, 1);
        const approved = entries.slice(1);
        const ctx = context();
        const choices = { selected: null, disposal: "trash" as const, remember: "once" as const, note: null };
        const { batch } = approveDelete({ ctx, request, approved, denied: [], choices });
        saveApproved({
            request,
            answer: { approved: true, via: "touch-id", choices, deniedByPerson: false },
            approved,
            denied: [],
            pending: blocked.map((entry) => entry.wanted),
            batchId: batch?.id,
            ctx,
        });
        const saved = loadRmRequest(request.id);
        expect(saved?.status).toBe("pending");
        expect(saved?.targets.map((target) => target.path)).toEqual([blocked[0]?.wanted.path]);
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);
        expect(existsSync(blocked[0]?.wanted.stored ?? "")).toBe(true);
    });

    test("an unavailable trash keeps the refused aside item pending after partial approval", () => {
        const request = asideRequest("unwritable-volume");
        const entries = entriesOf(request);
        const ctx = context();
        const choices = { selected: null, disposal: "trash" as const, remember: "once" as const, note: null };
        const refused: ApproveEntry[] = [];
        const { batch, back } = approveDelete({
            ctx,
            request,
            approved: entries,
            denied: [],
            choices,
            onRefused: (entry) => refused.push(entry),
            hooks: {
                beforeTrashRoot: (move) => {
                    if (move.target.path === entries[0]?.target.path) {
                        throw Object.assign(new Error("unwritable"), { code: "EACCES" });
                    }
                },
            },
        });
        expect(back.kept).toEqual([]);
        expect(refused).toEqual([entries[0]]);
        expect(batch?.items.map((item) => item.original)).toEqual([entries[1]?.wanted.path]);
        saveApproved({
            request,
            answer: { approved: true, via: "touch-id", choices, deniedByPerson: false },
            approved: entries.filter((entry) => !refused.includes(entry)),
            denied: [],
            pending: refused.map((entry) => entry.wanted),
            batchId: batch?.id,
            ctx,
        });
        const saved = loadRmRequest(request.id);
        expect(saved?.status).toBe("pending");
        expect(saved?.targets.map((target) => target.path)).toEqual([entries[0]?.wanted.path]);
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);
        expect(existsSync(entries[0]?.wanted.stored ?? "")).toBe(true);
    });

    test("failed put-backs stay protected and can be retried without losing the trash batch", () => {
        const request = asideRequest("partial-retry");
        const [a, b] = request.targets.map((target) => target.path);
        if (!a || !b) {
            throw new Error("expected two targets");
        }
        file(b);
        const { approved, denied } = splitBySelection(entriesOf(request), [a]);
        const choices = { selected: [a], disposal: "trash" as const, remember: "once" as const, note: null };
        const ctx = context();
        const { batch, back } = approveDelete({ ctx, request, approved, denied, choices });
        const pending = denied.filter((entry) => back.kept.some((kept) => kept.path === entry.wanted.path));
        expect(back.kept.map((item) => item.path)).toEqual([b]);
        saveApproved({
            request,
            answer: { approved: true, via: "touch-id", choices, deniedByPerson: false },
            approved,
            denied: [],
            pending: pending.map((entry) => entry.wanted),
            batchId: batch?.id,
            ctx,
        });
        const saved = loadRmRequest(request.id);
        expect(saved).toMatchObject({ status: "pending", batchId: batch?.id, decided: { approved: [a], denied: [] } });
        expect(saved?.targets.map((item) => item.path)).toEqual([b]);
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);
        renameSync(b, `${b}.replacement`);
        if (!saved) {
            throw new Error("expected pending request");
        }
        expect(denyRequest(saved, { caller: PERSON, via: "cli" }).kept).toEqual([]);
        expect(loadRmRequest(request.id)).toMatchObject({ status: "approved", batchId: batch?.id });
        expect(existsSync(b)).toBe(true);
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(false);
    });

    test("a failed deny keeps its aside copy pending", () => {
        const request = asideRequest("deny-retry");
        const path = request.targets[0]?.path ?? "";
        file(path);
        expect(denyRequest(request, { caller: PERSON, via: "cli" }).kept.map((item) => item.path)).toEqual([path]);
        expect(loadRmRequest(request.id)?.status).toBe("pending");
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);
    });

    test("a person denial survives a CLI recovery retry for every original target", () => {
        const request = asideRequest("denial-history");
        const paths = request.targets.map((target) => target.path);
        const blocked = paths[0];
        if (!blocked) {
            throw new Error("expected a target");
        }
        file(blocked);
        denyRequest(request, { caller: PERSON, via: "touch-id", note: "keep these files" });
        const pending = loadRmRequest(request.id);
        if (!pending) {
            throw new Error("expected a pending request");
        }
        renameSync(blocked, `${blocked}.replacement`);
        denyRequest(pending, { caller: PERSON, via: "cli" });
        const saved = loadRmRequest(request.id);
        expect(saved).toMatchObject({ status: "denied", decidedVia: "touch-id", deniedNote: "keep these files" });
        expect(priorDenials(paths, "sess-2222", listRmRequests({ all: true })).map((item) => item.note)).toEqual([
            "keep these files",
            "keep these files",
        ]);
    });

    test("a put-back that fails on I/O keeps its copy pending and guarded instead of throwing", () => {
        const request = asideRequest("io-fail");
        const [a, b] = request.targets.map((target) => target.path);
        if (!a || !b) {
            throw new Error("expected two targets");
        }
        const home = dirname(b);
        const { approved, denied } = splitBySelection(entriesOf(request), [a]);
        const choices = { selected: [a], disposal: "trash" as const, remember: "once" as const, note: null };
        chmodSync(home, 0o555);

        try {
            const { batch, back } = approveDelete({ ctx: context(), request, approved, denied, choices });
            expect(back.kept.map((item) => item.path)).toEqual([b]);
            expect(back.kept[0]?.reason).toContain("the put-back failed");
            const pending = stillAside(
                denied.map((entry) => entry.wanted),
                back
            );
            expect(pending.map((target) => target.path)).toEqual([b]);
            saveApproved({
                request,
                answer: { approved: true, via: "touch-id", choices, deniedByPerson: false },
                approved,
                denied,
                pending,
                batchId: batch?.id,
                ctx: context(),
            });
        } finally {
            chmodSync(home, 0o755);
        }

        const saved = loadRmRequest(request.id);
        expect(saved).toMatchObject({ status: "pending", decided: { approved: [a], denied: [b] } });
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);
        if (!saved) {
            throw new Error("expected a pending request");
        }
        expect(denyRequest(saved, { caller: PERSON, via: "cli" }).kept).toEqual([]);
        expect(existsSync(b)).toBe(true);
        expect(loadRmRequest(request.id)?.status).toBe("approved");
    });

    test("a deny whose aside copy is gone closes the request, since nothing is left to guard", () => {
        const request = asideRequest("copy-gone");
        const stored = request.targets[0]?.stored;
        if (!stored) {
            throw new Error("expected an aside copy");
        }
        renameSync(stored, join(base, "copy-gone-elsewhere.txt"));

        expect(denyRequest(request, { caller: PERSON, via: "cli" }).kept.map((item) => item.reason)).toEqual([
            `the aside copy is gone (${stored})`,
        ]);
        expect(loadRmRequest(request.id)?.status).toBe("denied");
    });

    test("a permanent delete is due at once", () => {
        const request = asideRequest("gone");
        const { batch } = approveDelete({
            ctx: context(),
            request,
            approved: entriesOf(request),
            denied: [],
            choices: { selected: null, disposal: "permanent", remember: "once", note: null },
        });

        expect(batch?.items).toHaveLength(2);
        expect(Date.parse(batch?.drainAfter ?? "")).toBeLessThanOrEqual(Date.now());
    });

    test("a deny with a note puts everything back and the agent reads the note on its next ask", () => {
        const request = asideRequest("kept");
        denyRequest(request, { caller: PERSON, via: "touch-id", note: "these are fixtures" });

        expect(request.targets.every((target) => existsSync(target.path))).toBe(true);
        expect(loadRmRequest(request.id)).toMatchObject({ status: "denied", deniedNote: "these are fixtures" });
        expect(
            priorDenials(
                request.targets.map((target) => target.path),
                "sess-2222",
                listRmRequests({ all: true })
            ).map((denial) => denial.note)
        ).toEqual(["these are fixtures", "these are fixtures"]);
    });
});

describe("config set", () => {
    test("enable-preset turns on a custom opt-in preset, not only a shipped one", () => {
        const custom = { id: "shared-cache", description: "a shared cache", names: ["cache"], optIn: true };
        const config = { ...defaultRmConfig(), customPresets: [custom] };
        const next = applyRmSetting(config, "enable-preset", "shared-cache");

        expect(presetsFor(config).some((p) => p.id === "shared-cache")).toBe(false);
        expect(presetsFor(next).some((p) => p.id === "shared-cache")).toBe(true);
        expect(applyRmSetting(config, "enable-preset", "no-such-preset").enabledPresets).toEqual(config.enabledPresets);
    });

    test("a trash-root move is checked again at the save, against the config and the trash as they are then", () => {
        const configPath = join(base, "settings-recheck", "config.json");
        const paths = {
            batchesDir: join(base, "settings-recheck", "batches"),
            lockPath: join(base, "settings-recheck", "lock"),
        };
        const oldRoot = join(base, "settings-recheck", "GenesisTools", "rm");
        const newRoot = join(base, "settings-recheck", "other", "GenesisTools", "rm");
        const own = { ...defaultRmConfig(), trashRoot: oldRoot };
        saveRmConfig(own, configPath);
        // While the person decided: a batch reached the old root, and another setting was saved.
        const target = resolveTarget(file(join(base, "settings-recheck", "late.txt")), base);
        const batch = moveToTrash([{ target, rule: "test" }], {
            config: own,
            caller: AGENT,
            graceMinutes: 60,
            paths,
            currentTrashRoot: () => loadRmConfig(configPath).trashRoot,
        });
        saveRmConfig({ ...own, approval: "code" }, configPath);

        const blocked = saveRmSetting({
            key: "trash-root",
            value: newRoot,
            drainCommand: "drain-now",
            paths,
            configPath,
        });

        expect(blocked).toEqual({ blocked: expect.stringContaining("drain-now") });
        expect(loadRmConfig(configPath).trashRoot).toBe(oldRoot);

        restoreBatch(batch?.id ?? "", { config: own, paths });
        const saved = saveRmSetting({
            key: "trash-root",
            value: newRoot,
            drainCommand: "drain-now",
            paths,
            configPath,
        });

        expect("saved" in saved && saved.saved.trashRoot).toBe(newRoot);
        expect(loadRmConfig(configPath)).toMatchObject({ trashRoot: newRoot, approval: "code" });
    });

    describe("a move and a trash-root change at the same time", () => {
        /** A config file with its own old root, its own batches, and one file to move. */
        function race(name: string) {
            const folder = join(base, name);
            const configPath = join(folder, "config.json");
            const paths = { batchesDir: join(folder, "batches"), lockPath: join(folder, "lock") };
            const oldRoot = join(folder, "GenesisTools", "rm");
            const newRoot = join(folder, "other", "GenesisTools", "rm");
            const loaded = { ...defaultRmConfig(), trashRoot: oldRoot };
            saveRmConfig(loaded, configPath);
            const target = resolveTarget(file(join(folder, "src", "a.txt")), base);
            const refused: string[] = [];
            const move = (config: RmConfig, hooks?: { afterClaim?: () => void }) =>
                moveToTrash([{ target, rule: "test" }], {
                    config,
                    caller: AGENT,
                    graceMinutes: 60,
                    paths,
                    currentTrashRoot: () => loadRmConfig(configPath).trashRoot,
                    onRefused: (_request, reason) => refused.push(reason),
                    hooks,
                });
            const setRoot = (hooks?: { afterCheck?: () => void }) =>
                saveRmSetting({
                    key: "trash-root",
                    value: newRoot,
                    drainCommand: "drain-now",
                    paths,
                    configPath,
                    hooks,
                });
            return { configPath, paths, oldRoot, newRoot, loaded, target, refused, move, setRoot };
        }

        test("a claim written before the change's check refuses the change, and the move lands in the old root", () => {
            const r = race("race-claim-first");
            const changes: Array<ReturnType<typeof r.setRoot>> = [];
            const batch = r.move(r.loaded, {
                afterClaim: () => {
                    changes.push(r.setRoot());
                },
            });

            expect(changes).toEqual([{ blocked: expect.stringContaining("drain-now") }]);
            expect(loadRmConfig(r.configPath).trashRoot).toBe(r.oldRoot);
            expect(r.refused).toEqual([]);
            expect(batch?.items[0]?.stored.startsWith(r.oldRoot)).toBe(true);
            expect(existsSync(r.target.path)).toBe(false);

            restoreBatch(batch?.id ?? "", { config: r.loaded, paths: r.paths });
        });

        test("a claim written while the change runs moves nothing, and the change is saved", () => {
            const r = race("race-change-first");
            let batch: ReturnType<typeof r.move> | undefined;
            const change = r.setRoot({
                afterCheck: () => {
                    batch = r.move(r.loaded);
                },
            });

            expect(change).toMatchObject({ saved: { trashRoot: r.newRoot } });
            expect(batch).toBeNull();
            expect(r.refused).toEqual([expect.stringContaining("being changed right now")]);
            expect(existsSync(r.target.path)).toBe(true);
            expect(readdirSync(r.paths.batchesDir)).toEqual([]);
        });

        test("a run that read the config before a finished change moves nothing into the old root", () => {
            const r = race("race-stale-config");

            expect(r.setRoot()).toMatchObject({ saved: { trashRoot: r.newRoot } });
            expect(r.move(r.loaded)).toBeNull();
            expect(r.refused).toEqual([expect.stringContaining(`changed to ${r.newRoot}`)]);
            expect(existsSync(r.target.path)).toBe(true);
            expect(readdirSync(r.paths.batchesDir)).toEqual([]);
        });

        test("without overlap both work: the root changes, then a run that reads the new config moves into it", () => {
            const r = race("race-no-overlap");

            expect(r.setRoot()).toMatchObject({ saved: { trashRoot: r.newRoot } });
            const batch = r.move(loadRmConfig(r.configPath));

            expect(r.refused).toEqual([]);
            expect(batch?.items[0]?.stored.startsWith(r.newRoot)).toBe(true);
            expect(existsSync(r.target.path)).toBe(false);

            restoreBatch(batch?.id ?? "", { config: loadRmConfig(r.configPath), paths: r.paths });
        });
    });
});

describe("sizes measured with the request", () => {
    /** A folder with two files named in place by a pending request, as `tools rm` leaves an in-place ask. */
    function inPlaceRequest(folder: string): RmRequest {
        const dir = join(base, folder, "cache");
        file(join(dir, "a.bin"));
        file(join(dir, "sub", "b.bin"));
        return createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: join(base, folder),
            reason: "cleanup",
            targets: [{ path: dir, kind: "dir", rule: "nested-repos", reason: "holds a repository" }],
        });
    }

    /** Row seams that fail the test when the window walks a tree itself. */
    function noWalk(): Partial<ApprovalRowDeps> {
        return {
            measure: () => {
                throw new Error("the window walked a tree that the pass had measured");
            },
            probeGit: async () => new Map(),
            passRunning: () => false,
        };
    }

    async function collect(rows: ReturnType<typeof approvalRows>): Promise<ApprovalItemUpdate[]> {
        const seen: ApprovalItemUpdate[] = [];

        for await (const update of rows.updates.read()) {
            seen.push(update);
        }

        await rows.done;
        return seen;
    }

    test("a request carries its bytes after the background pass", async () => {
        const request = inPlaceRequest("measured");
        const at = new Date("2026-10-31T12:00:00.000Z");
        const result = await measureRmRequest(request.id, { now: () => at });

        expect(result).toEqual({ measured: 1, fresh: 0, busy: false });
        expect(loadRmMeasurements(request.id)?.items).toEqual([
            expect.objectContaining({
                path: request.targets[0]?.path,
                at: at.toISOString(),
                bytes: expect.any(Number),
                empty: false,
                folderStats: expect.objectContaining({ files: 2 }),
            }),
        ]);
        expect(loadRmMeasurements(request.id)?.items[0]?.bytes).toBeGreaterThan(0);
        // A second pass finds the saved numbers fresh and walks nothing.
        expect(await measureRmRequest(request.id)).toEqual({ measured: 0, fresh: 1, busy: false });
    });

    test("approve uses the stored bytes and does not measure again", async () => {
        const request = inPlaceRequest("stored");
        await measureRmRequest(request.id);
        const saved = loadRmMeasurements(request.id)?.items[0];
        const rows = approvalRows(request, entriesOf(request), {
            signal: new AbortController().signal,
            deps: noWalk(),
        });

        expect(rows.items[0]).toMatchObject({ bytes: saved?.bytes, folderStats: { files: 2 } });
        expect(rows.items[0]?.measuring).toBeUndefined();
        expect(await collect(rows)).toEqual([]);
    });

    test("a row without a fresh size opens as measuring and gets its size after the window opened", async () => {
        const request = inPlaceRequest("changed");
        await measureRmRequest(request.id);
        // A new entry at the top changes the folder's mtime: the saved size no longer describes it.
        file(join(request.targets[0]?.path ?? "", "late.bin"));
        let walks = 0;
        const rows = approvalRows(request, entriesOf(request), {
            signal: new AbortController().signal,
            deps: {
                ...noWalk(),
                measure: async (target) => {
                    walks++;
                    return { path: target.path, location: target.path, at: "", mtimeMs: 0, bytes: 4096 };
                },
            },
        });

        expect(rows.items[0]).toMatchObject({ measuring: true });
        expect(rows.items[0]?.bytes).toBeUndefined();
        expect(await collect(rows)).toEqual([{ path: request.targets[0]?.path, bytes: 4096, measuring: false }]);
        expect(walks).toBe(1);
    });

    test("a size known from an older aside move opens at once, and its folder stats follow the window", async () => {
        const dir = join(base, "older-aside", "cache");
        file(join(dir, "a.bin"));
        file(join(dir, "sub", "b.bin"));
        const request = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: join(base, "older-aside"),
            reason: "cleanup",
            targets: [{ path: dir, kind: "dir", rule: "default", reason: "no rule allows it", bytes: 8192 }],
        });
        const rows = approvalRows(request, entriesOf(request), {
            signal: new AbortController().signal,
            deps: noWalk(),
        });

        // Nothing under the folder is listed before the window opens.
        expect(rows.items[0]).toMatchObject({ bytes: 8192 });
        expect(rows.items[0]?.folderStats).toBeUndefined();
        expect(rows.items[0]?.measuring).toBeUndefined();
        expect(await collect(rows)).toEqual([
            { path: dir, empty: false, folderStats: expect.objectContaining({ files: 2 }) },
        ]);
    });

    test("a size that cannot be saved still reaches the window, and the rows never reject", async () => {
        const request = inPlaceRequest("unsaved");
        const rows = approvalRows(request, entriesOf(request), {
            signal: new AbortController().signal,
            deps: {
                ...noWalk(),
                measure: async (target) => ({
                    path: target.path,
                    location: target.path,
                    at: "",
                    mtimeMs: 0,
                    bytes: 4096,
                }),
                record: () => {
                    throw new Error("ENOSPC: no space left on device");
                },
            },
        });

        expect(await collect(rows)).toContainEqual({ path: request.targets[0]?.path, bytes: 4096, measuring: false });
    });

    test("the window follows a running pass instead of walking the same tree", async () => {
        const request = inPlaceRequest("following");
        let running = true;
        const rows = approvalRows(request, entriesOf(request), {
            signal: new AbortController().signal,
            deps: { ...noWalk(), passRunning: () => running, followMs: 5 },
        });
        await measureRmRequest(request.id);
        running = false;

        expect(rows.items[0]).toMatchObject({ measuring: true });
        expect(await collect(rows)).toEqual([
            expect.objectContaining({ path: request.targets[0]?.path, measuring: false, bytes: expect.any(Number) }),
        ]);
    });
});

describe("a run that asks", () => {
    test("opens one request per run, and that request owns the aside copies", async () => {
        const paths = [file(join(base, "ask-once", "a.txt")), file(join(base, "ask-once", "b.txt"))];
        const verdict = { kind: "ask" as const, rule: "default", reason: "no rule allows it" };
        const plan = paths.map((path) => ({ target: resolveTarget(path, base), verdict }));
        const before = new Set(listRmRequests().map((request) => request.id));
        const started: string[] = [];
        const exitCode = process.exitCode;

        try {
            const result = await executePlan(
                plan,
                { ...context(), caller: AGENT },
                { aside: true },
                {
                    startMeasurement: (id) => started.push(id),
                    kickDrainer: () => undefined,
                    asideRoot: join(base, "aside", "ask-once"),
                }
            );
            const opened = listRmRequests().filter((request) => !before.has(request.id));

            expect(opened.map((request) => request.id)).toEqual([result.requestId ?? ""]);
            expect(started).toEqual([result.requestId ?? ""]);
            expect(opened[0]?.targets.map((target) => target.path).sort()).toEqual([...paths].sort());
            expect(opened[0]?.targets.every((target) => target.stored && existsSync(target.stored))).toBe(true);
            expect(paths.some((path) => existsSync(path))).toBe(false);
        } finally {
            process.exitCode = exitCode;
        }
    });
});

interface Seen {
    path: string;
    opts: Record<string, unknown>;
}

/** The real tools rm program with every action replaced by one that records which command got which flags. */
function recordingProgram(seen: Seen[]): Command {
    const program = createRmProgram();
    const stub = (command: Command, path: string): void => {
        command.exitOverride();
        command.configureOutput({ writeErr: () => {}, writeOut: () => {} });

        if (command.commands.length === 0 || path === "") {
            command.action(function (this: Command) {
                seen.push({ path, opts: this.opts() });
            });
        }

        for (const sub of command.commands) {
            stub(sub, path === "" ? sub.name() : `${path} ${sub.name()}`);
        }
    };
    stub(program, "");
    return program;
}

async function parsed(argv: string[]): Promise<Seen> {
    const seen: Seen[] = [];
    await recordingProgram(seen).parseAsync(argv, { from: "user" });
    const last = seen.at(-1);

    if (!last) {
        throw new Error(`no action ran for ${argv.join(" ")}`);
    }

    return last;
}

describe("flag ownership", () => {
    test("a subcommand's own flags reach it, not the root", async () => {
        expect(await parsed(["preset", "node_modules", "-n", "--keep", "1d"])).toMatchObject({
            path: "preset",
            opts: { dryRun: true, keep: 1440, depth: 8 },
        });
        expect(await parsed(["requests", "--json"])).toMatchObject({ path: "requests", opts: { json: true } });
        expect(await parsed(["drain", "--now"])).toMatchObject({ path: "drain", opts: { now: true } });
        expect(await parsed(["roots", "list", "--json"])).toMatchObject({ path: "roots list", opts: { json: true } });
    });

    test("the root still takes its flags for tools rm [flags] <paths>", async () => {
        expect(await parsed(["-n", "a", "b"])).toMatchObject({ path: "", opts: { dryRun: true } });
    });

    test("a remove flag before a subcommand name is refused, never dropped", async () => {
        const error = await parsed(["-n", "preset", "node_modules"]).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CommanderError);
        expect(error instanceof CommanderError ? error.exitCode : null).toBe(2);
    });
});

describe("the requests listing", () => {
    const NOW = new Date("2026-11-01T14:00:00.000Z");
    const ASKER: RmCaller = {
        agent: "claude-code",
        sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
        isInAgent: true,
        sessionTitle: "cleanup run",
        project: "shop",
    };
    const OTHER: RmCaller = { ...ASKER, sessionId: "bbbbbbbb-2222-4222-8222-222222222222", sessionTitle: "probe work" };
    const NO_RULE = "no rule allows it: a preset, this session's scratch or own files, or a trusted root";
    const scratch = "/tmp/cc/shop/aaaaaaaa-1111-4111-8111-111111111111";

    function req(
        id: string,
        caller: RmCaller,
        createdAt: string,
        targets: RmRequest["targets"],
        extra: Partial<RmRequest> = {}
    ): RmRequest {
        return {
            id,
            kind: "delete",
            createdAt,
            caller,
            cwd: "/work/shop",
            reason: null,
            targets,
            status: "pending",
            ...extra,
        };
    }

    const requests: RmRequest[] = [
        req("aside1", ASKER, "2026-11-01T13:49:00.000Z", [
            {
                path: "/tmp/cc-ds.json",
                kind: "file",
                rule: "default",
                reason: NO_RULE,
                stored: `${scratch}/rm-aside/1/0-x-cc-ds.json`,
            },
        ]),
        req(
            "gone22",
            ASKER,
            "2026-10-31T16:43:00.000Z",
            [
                {
                    path: "/tmp/cc/shop/cccccccc-3333-4333-8333-333333333333/review/pr-1",
                    kind: "dir",
                    rule: "nested-repos",
                    reason: "holds 6 git repositories",
                },
            ],
            {
                decidedAt: "2026-10-31T17:08:16.000Z",
                decidedVia: "touch-id",
                decided: { approved: ["/x/1", "/x/2", "/x/3", "/x/4"], denied: [] },
                batchId: "20261031-170802-1-6ce5",
            }
        ),
        req("lost33", OTHER, "2026-10-27T23:44:00.000Z", [
            {
                path: "/tmp/cc/shop/bbbbbbbb/removals/npm-diff",
                kind: "dir",
                rule: "default",
                reason: NO_RULE,
                stored: "/tmp/cc/shop/bbbbbbbb-2222-4222-8222-222222222222/rm-aside/2/0-y-npm-diff",
            },
        ]),
        req("dupaaa", OTHER, "2026-11-01T04:29:00.000Z", [
            { path: "/work/shop/.smoke.tmp.ts", kind: "file", rule: "git-untracked", reason: "1 untracked file" },
        ]),
        req("dupbbb", OTHER, "2026-11-01T04:39:00.000Z", [
            { path: "/work/shop/.smoke.tmp.ts", kind: "file", rule: "git-untracked", reason: "1 untracked file" },
        ]),
    ];
    // On disk: the aside copy of aside1 and the in-place file, nothing else.
    const present = (path: string) => path.startsWith(`${scratch}/rm-aside/1/`) || path === "/work/shop/.smoke.tmp.ts";
    const sizes: Record<string, number> = { aside1: 45_056, dupaaa: 4096, dupbbb: 4096, lost33: 839_680 };
    const views = buildRequestViews(requests, { present, sizeOf: (request) => sizes[request.id] });

    test("one summary, one group per session, no repeated reason, no aside location", () => {
        const lines = renderRequestList(views, { now: NOW, caller: PERSON }).map(stripAnsi);
        const text = lines.join("\n");
        expect(lines[0]).toContain("5 open · 5 paths · 864.0 KB aside · 3 in place · oldest 4d");
        expect(text).toContain(
            "Needs a look: 1 gone (gone22) · 1 copy lost (lost33) · 1 asked twice (dupaaa = dupbbb)"
        );
        expect(text).not.toContain(NO_RULE);
        expect(text.split("no rule = ").length).toBe(2);
        expect(text).not.toContain("rm-aside");
        expect(text.indexOf("aaaaaaaa cleanup run")).toBeLessThan(text.indexOf("bbbbbbbb probe work"));
        expect(text).toContain(`Approve: ${toolCommand("rm")} approve <id>`);
        expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(124);
    });

    test("an agent reads the agent's footer", () => {
        const text = renderRequestList(views, { now: NOW, caller: ASKER }).map(stripAnsi).join("\n");
        expect(text).toContain(`The user approves: ! ${toolCommand("rm")} approve <id>`);
        expect(text).toContain(`Cancel your own: ${toolCommand("rm")} deny <id>`);
    });

    test("the detail view shows the decision even when nothing was denied", () => {
        const gone = views.find((view) => view.request.id === "gone22");
        const detail = gone ? renderRequestDetail(gone, NOW).map(stripAnsi).join("\n") : "";
        expect(detail).toContain("4 approved");
        expect(detail).toContain("via touch-id, 0 denied; batches 20261031-170802-1-6ce5");
        expect(detail).toContain("nested-repos: holds 6 git repositories");
    });

    test("paths read short: own scratch, another session, home, temp folder", () => {
        const ctx = { home: "/Users/alice", tmpdir: "/var/folders/ab/xyz123/T", sessionId: ASKER.sessionId };
        expect(shortRmPath(`${scratch.replace("/shop/", "/GenesisTools/")}/18-filetree`, ctx)).toBe(
            "<scratch>/18-filetree"
        );
        expect(shortRmPath("/tmp/cc/GenesisTools/cccccccc-3333-4333-8333-333333333333/review/pr-623", ctx)).toBe(
            "GenesisTools/cccccccc/review/pr-623"
        );
        expect(shortRmPath("/private/var/folders/ab/xyz123/T/.tmp-reclaim-58Uz7S", ctx)).toBe(
            "$TMPDIR/.tmp-reclaim-58Uz7S"
        );
        expect(shortRmPath("/Users/alice/Projects/a-long-client-folder-name/shop/.smoke.tmp.ts", ctx)).toBe(
            "~/Projects/a-long-client-folder-n…/.smoke.tmp.ts"
        );
    });
});

describe("the decision lock", () => {
    test("a request open in another process is never decided twice", async () => {
        const request = createRmRequest({ kind: "delete", caller: AGENT, cwd: base, reason: null, targets: [] });
        // A live pid that is not ours holds it, as the second approve window did on 2026-10-31.
        writeFileSync(rmRequestLockFile(request.id), String(process.ppid));
        let ran = false;
        const done = await underDecisionLock(
            request.id,
            () => "busy",
            () => {
                ran = true;
            }
        );
        expect(done).toBe(false);
        expect(ran).toBe(false);
    });

    test("the same process may nest, and the lock file goes when the outer decision ends", async () => {
        const request = createRmRequest({ kind: "delete", caller: AGENT, cwd: base, reason: null, targets: [] });
        let inner = false;
        await underDecisionLock(
            request.id,
            () => "busy",
            async () => {
                inner = await underDecisionLock(
                    request.id,
                    () => "busy",
                    () => {}
                );
                expect(existsSync(rmRequestLockFile(request.id))).toBe(true);
            }
        );
        expect(inner).toBe(true);
        expect(existsSync(rmRequestLockFile(request.id))).toBe(false);
    });

    test("an update writes from the copy on disk, not from one read earlier", () => {
        const targets = [
            { path: join(base, "lock-s1"), kind: "file" as const, rule: "default", reason: "r" },
            { path: join(base, "lock-s2"), kind: "file" as const, rule: "default", reason: "r" },
        ];
        const request = createRmRequest({ kind: "delete", caller: AGENT, cwd: base, reason: null, targets });
        saveRmRequest({ ...request, deniedNote: "written by another window" });
        const update = updateRmRequest(request.id, (fresh) => ({ ...fresh, targets: fresh.targets.slice(1) }));
        expect(update.kind).toBe("saved");
        expect(loadRmRequest(request.id)?.deniedNote).toBe("written by another window");
        expect(loadRmRequest(request.id)?.targets.map((target) => target.path)).toEqual([join(base, "lock-s2")]);
    });
});

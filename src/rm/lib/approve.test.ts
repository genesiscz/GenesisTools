import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    type ApprovalItemUpdate,
    type ApprovalPrompt,
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
    readRmLedger,
    recoverAsideJournals,
    requestBatchIds,
    resolveTarget,
    restoreBatch,
    rmCallerFromRuntime,
    rmRequestLockFile,
    rmRequestsDir,
    saveRmConfig,
    saveRmRequest,
    stillAside,
    updateRmRequest,
} from "@genesiscz/utils/rm";
import { stripAnsi } from "@genesiscz/utils/string";
import { type Command, CommanderError } from "commander";
import { describePolicy } from "../commands/profiles";
import { approveMany, denyPicked, underDecisionLock } from "../commands/requests";
import { applyRmSetting, saveRmSetting } from "../commands/settings";
import { agentMayDrainEarly } from "../commands/trash";
import { createRmProgram } from "../program";
import {
    type ApprovalRowDeps,
    type ApproveEntry,
    approvalRows,
    approveDelete,
    denyRequest,
    saveApproved,
    splitBySelection,
} from "./approve";
import { shortRmPath } from "./display";
import { renderLedger } from "./log-view";
import { type NotifyDeps, notifyNewRequest, type RequestNotice } from "./notify";
import { buildRequestViews, renderRequestDetail, renderRequestList } from "./requests-view";
import { type ExecuteDeps, executePlan, type PersonAnswer, printRequestHint, type RunContext } from "./run";
import { renderConfig, renderPresets, renderRoots } from "./settings-view";
import { batchSuffix, renderTrash, resolveBatchSuffix } from "./trash-view";

const AGENT: RmCaller = { agent: "claude-code", sessionId: "sess-2222", isInAgent: true };
const PERSON: RmCaller = { agent: "person", sessionId: null, isInAgent: false };

let base: string;
let config: RmConfig;

function file(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    return path;
}

/** A run's background work, made inert: a dry run starts none of it. */
const DRY_DEPS = {
    startMeasurement: () => undefined,
    kickDrainer: () => undefined,
    notifyRequest: async () => undefined,
};

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
        expect(denyRequest(saved, { caller: PERSON, via: "cli" }).back.kept).toEqual([]);
        expect(loadRmRequest(request.id)).toMatchObject({ status: "approved", batchId: batch?.id });
        expect(existsSync(b)).toBe(true);
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(false);
    });

    test("a failed deny keeps its aside copy pending", () => {
        const request = asideRequest("deny-retry");
        const path = request.targets[0]?.path ?? "";
        file(path);
        expect(denyRequest(request, { caller: PERSON, via: "cli" }).back.kept.map((item) => item.path)).toEqual([path]);
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
        expect(denyRequest(saved, { caller: PERSON, via: "cli" }).back.kept).toEqual([]);
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

        // The gone copy is reported as lost, not as one that still needs recovery.
        const outcome = denyRequest(request, { caller: PERSON, via: "cli" });
        expect(outcome.lost.map((item) => item.stored)).toEqual([stored]);
        expect(outcome.waiting).toEqual([]);
        expect(outcome.back.kept).toEqual([]);
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
                    notifyRequest: async () => undefined,
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

    /** Runs `tools rm <path> --no-aside` for `caller`, as an agent would, and returns the request id it got. */
    async function askInPlace(
        path: string,
        caller: RmCaller,
        started: string[],
        options: { notifyRequest?: ExecuteDeps["notifyRequest"]; ctx?: RunContext } = {}
    ): Promise<string | null> {
        const verdict = { kind: "ask" as const, rule: "default", reason: "no rule allows it" };
        const exitCode = process.exitCode;

        try {
            const result = await executePlan(
                [{ target: resolveTarget(path, base), verdict }],
                { ...(options.ctx ?? context()), caller },
                { aside: false },
                {
                    startMeasurement: (id) => started.push(id),
                    kickDrainer: () => undefined,
                    notifyRequest: options.notifyRequest ?? (async () => undefined),
                }
            );
            return result.requestId;
        } finally {
            process.exitCode = exitCode;
        }
    }

    test("the same session asking again for an in-place path reuses its open request", async () => {
        const path = file(join(base, "ask-twice", "smoke.tmp.ts"));
        const started: string[] = [];
        const first = await askInPlace(path, AGENT, started);
        const second = await askInPlace(path, AGENT, started);
        const naming = listRmRequests().filter((request) => request.targets.some((target) => target.path === path));

        expect(first).not.toBeNull();
        expect(second).toBe(first);
        expect(started).toEqual([first ?? ""]);
        expect(naming.map((request) => request.id)).toEqual([first ?? ""]);
    });

    test("another session asking for the same path gets its own request", async () => {
        const path = file(join(base, "ask-other", "smoke.tmp.ts"));
        const started: string[] = [];
        const first = await askInPlace(path, AGENT, started);
        const second = await askInPlace(path, { ...AGENT, sessionId: "sess-3333" }, started);

        expect(second).not.toBe(first);
        expect(started).toHaveLength(2);
    });

    test("a dry run prints one row per path, the reasons once, and a summary split by what happens", async () => {
        const dir = join(base, "dry-run");
        file(join(dir, "keep.txt"));
        file(join(dir, "cache", "index.json"));
        const ask = { kind: "ask" as const, rule: "default", reason: "no rule allows it" };
        const plan = [
            { target: resolveTarget(join(dir, "keep.txt"), dir), verdict: ask },
            {
                target: resolveTarget(join(dir, "cache"), dir),
                verdict: { ...ask, stayInPlace: "a live cache: another install may read it" },
            },
            {
                target: resolveTarget(join(dir, "gone.txt"), dir),
                verdict: { kind: "deny" as const, rule: "hard-deny", reason: "it does not exist" },
            },
        ];
        const lines: string[] = [];
        const println = spyOn(out, "println").mockImplementation((raw?: unknown) => {
            lines.push(stripAnsi(String(raw ?? "")));
        });
        let printed: unknown[] = [];
        const result = spyOn(out, "result").mockImplementation((value: unknown) => {
            printed = Array.isArray(value) ? value : [];
        });

        try {
            const ctx = { ...context(), caller: AGENT, cwd: dir };
            await executePlan(plan, ctx, { dryRun: true, aside: true }, DRY_DEPS);
            await executePlan(plan, ctx, { dryRun: true, aside: true, json: true }, DRY_DEPS);
        } finally {
            println.mockRestore();
            result.mockRestore();
        }

        expect(lines[0]).toMatch(/^VERDICT\s+SIZE\s+PATH\s+RULE$/);
        expect(lines[1]).toMatch(/^ask\s+[\d.]+ KB\s+keep\.txt\s+default · moves aside$/);
        expect(lines[2]).toMatch(
            /^ask\s+[\d.]+ KB\s+cache\s+default · stays in place \(a live cache: another install may read it\)$/
        );
        expect(lines[3]).toMatch(/^refuse\s+-\s+gone\.txt\s+hard-deny$/);
        expect(lines.filter((line) => line.includes("default: no rule allows it"))).toHaveLength(1);
        expect(lines.at(-1)).toMatch(
            /^Dry run: 0 B would go now · [\d.]+ KB needs the user \(1 request\) · 1 refused\. Nothing moved\.$/
        );
        expect(lines.some((line) => line.includes("would leave the disk") || line.includes("The trash holds"))).toBe(
            false
        );
        expect(printed).toMatchObject([
            { path: join(dir, "keep.txt"), willAside: true, alsoIn: [] },
            { path: join(dir, "cache"), willAside: false, alsoIn: [] },
            { verdict: "deny", willAside: false },
        ]);
    });

    test("a path whose verdict says it stays in place is not moved aside, even with aside on", async () => {
        const cache = join(base, "live-cache", "v10");
        file(join(cache, "index.json"));
        const verdict = {
            kind: "ask" as const,
            rule: "default",
            reason: "matches the opt-in preset shop-cache, which is off",
            stayInPlace: "a live cache: another install may read it",
        };
        const exitCode = process.exitCode;

        try {
            const result = await executePlan(
                [{ target: resolveTarget(cache, base), verdict }],
                { ...context(), caller: AGENT },
                { aside: true },
                {
                    startMeasurement: () => undefined,
                    kickDrainer: () => undefined,
                    asideRoot: join(base, "aside", "live-cache"),
                    notifyRequest: async () => undefined,
                }
            );
            const request = loadRmRequest(result.requestId ?? "");

            expect(request?.targets.map((target) => target.stored)).toEqual([undefined]);
            expect(existsSync(join(cache, "index.json"))).toBe(true);
        } finally {
            process.exitCode = exitCode;
        }
    });

    test("a new request reaches the person once per session in ten minutes, and never with notify-on-request none", async () => {
        const sent: RequestNotice[] = [];
        const notifyRequest: ExecuteDeps["notifyRequest"] = (request, ctx) =>
            notifyNewRequest(request, ctx, {
                send: async (_mode, notice) => {
                    sent.push(notice);
                },
                now: () => new Date(),
            });
        const caller: RmCaller = { ...AGENT, sessionId: "sess-5555", sessionTitle: "probe work", project: "shop" };
        const started: string[] = [];
        const first = await askInPlace(file(join(base, "notify", "a.txt")), caller, started, { notifyRequest });
        const second = await askInPlace(file(join(base, "notify", "b.txt")), caller, started, { notifyRequest });

        expect(second).not.toBe(first);
        expect(sent.map((notice) => notice.text)).toEqual([
            `Claude Code in shop (probe work) asks to delete 1 item. Review: ${toolCommand("rm")} approve ${first}`,
        ]);

        const quiet = { ...context(), base: { ...config, notify: { onRequest: "none" as const } } };
        await askInPlace(file(join(base, "notify", "c.txt")), { ...caller, sessionId: "sess-6666" }, started, {
            notifyRequest,
            ctx: quiet,
        });
        expect(sent).toHaveLength(1);
    });

    test("two runs of one session that ask at the same moment send one notice; a failed send gives the window back", async () => {
        const notice = (sessionId: string, id: string): RmRequest => ({
            id,
            kind: "delete",
            createdAt: new Date().toISOString(),
            caller: { ...AGENT, sessionId },
            cwd: base,
            reason: null,
            status: "pending",
            targets: [{ path: join(base, "notify-race", `${id}.txt`), kind: "file", rule: "default", reason: "x" }],
        });
        const sent: string[] = [];
        let open = () => {};
        const gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        const slow: NotifyDeps = {
            // A second send opens the gate at once, so a double send fails the count instead of hanging the test.
            send: async (_mode, message) => {
                sent.push(message.title);

                if (sent.length > 1) {
                    open();
                }

                await gate;
            },
            now: () => new Date(),
        };
        const calls = [
            notifyNewRequest(notice("sess-7777", "race01"), context(), slow),
            notifyNewRequest(notice("sess-7777", "race02"), context(), slow),
        ];
        await Promise.race(calls);
        open();
        await Promise.all(calls);

        expect(sent).toHaveLength(1);

        const delivered: string[] = [];
        const failing: NotifyDeps = {
            send: async () => {
                throw new Error("the inbox is down");
            },
            now: () => new Date(),
        };
        const working: NotifyDeps = {
            send: async (_mode, message) => {
                delivered.push(message.title);
            },
            now: () => new Date(),
        };
        await notifyNewRequest(notice("sess-8888", "fail01"), context(), failing);
        await notifyNewRequest(notice("sess-8888", "fail02"), context(), working);

        expect(delivered).toEqual([`${toolCommand("rm")} request fail02`]);
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

describe("a path named like a subcommand", () => {
    test("a listing subcommand says how to delete a file of its name in the current folder", async () => {
        const here = join(base, "shadowed");
        file(join(here, "log"));
        const notes: string[] = [];
        const printlnErr = spyOn(out, "printlnErr").mockImplementation((raw?: unknown) => {
            notes.push(stripAnsi(String(raw ?? "")));
        });
        const cwd = process.cwd();

        try {
            process.chdir(here);
            await parsed(["log", "--json"]);
            await parsed(["trash"]);
        } finally {
            process.chdir(cwd);
            printlnErr.mockRestore();
        }

        expect(notes).toEqual([
            `log here is a file; to delete it instead of running the log subcommand, write ${toolCommand("rm")} ./log`,
        ]);
    });

    test("a folder of a subcommand's name gets no note: the requests folder of the store is not a file to delete", async () => {
        const here = join(base, "store-like");
        mkdirSync(join(here, "requests"), { recursive: true });
        const notes: string[] = [];
        const printlnErr = spyOn(out, "printlnErr").mockImplementation((raw?: unknown) => {
            notes.push(stripAnsi(String(raw ?? "")));
        });
        const cwd = process.cwd();

        try {
            process.chdir(here);
            await parsed(["requests", "--json"]);
        } finally {
            process.chdir(cwd);
            printlnErr.mockRestore();
        }

        expect(notes).toEqual([]);
    });

    test("the help says to write ./<name>, because -- still runs the subcommand", () => {
        let help = "";
        const program = createRmProgram();
        program.configureOutput({ writeOut: (chunk) => (help += chunk), writeErr: () => {} });
        program.outputHelp();

        expect(help).toContain(`${toolCommand("rm")} ./log`);
    });
});

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
        // From the disk now: gone22's path is gone (not in place), lost33's lost copy is not aside.
        expect(lines[0]).toContain("5 open · 5 paths · 44.0 KB aside · 2 in place · oldest 4d");
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

    test("with --all a closed request shows its status, and only open ones count or need a look", () => {
        const closed = [
            req(
                "appr11",
                ASKER,
                "2026-10-31T10:00:00.000Z",
                [
                    {
                        path: "/tmp/cc-old.json",
                        kind: "file",
                        rule: "default",
                        reason: NO_RULE,
                        stored: `${scratch}/rm-aside/9/0-x-cc-old.json`,
                    },
                ],
                {
                    status: "approved",
                    decidedAt: "2026-10-31T10:05:00.000Z",
                    decidedVia: "touch-id",
                    decided: { approved: ["/tmp/cc-old.json"], denied: [] },
                }
            ),
            req(
                "deny11",
                OTHER,
                "2026-11-01T09:00:00.000Z",
                [{ path: "/work/shop/keep.txt", kind: "file", rule: "default", reason: NO_RULE }],
                {
                    status: "denied",
                    decidedAt: "2026-11-01T09:10:00.000Z",
                    decidedVia: "dialog",
                    decided: { approved: [], denied: ["/work/shop/keep.txt"] },
                }
            ),
        ];
        const all = buildRequestViews([...requests, ...closed], {
            present: (path) => present(path) || path === "/work/shop/keep.txt",
            sizeOf: (request) => sizes[request.id],
        });
        const lines = renderRequestList(all, { now: NOW, caller: PERSON }).map(stripAnsi);
        const text = lines.join("\n");
        const row = (id: string) => lines.find((line) => line.trimStart().startsWith(id)) ?? "";

        expect(lines[0]).toContain("5 open · 2 closed · 5 paths · 44.0 KB aside · 2 in place");
        // appr11's copy went to the trash by design: it is no copy lost to look at.
        expect(text).toContain("Needs a look: 1 gone (gone22) · 1 copy lost (lost33) · 1 asked twice");
        expect(row("appr11")).toContain("approved");
        expect(row("appr11")).toContain("approved 1, Oct 31");
        expect(row("appr11")).not.toContain("copy lost");
        expect(row("deny11")).toContain("denied 1, Nov 1");
        expect(row("deny11")).not.toContain("approved");

        const paths = renderRequestList(all, { now: NOW, caller: PERSON, paths: true }).map(stripAnsi);
        expect(paths.find((line) => line.includes("cc-old.json"))).toContain("approved");
        expect(paths.find((line) => line.includes("keep.txt"))).toContain("denied");
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

describe("nothing left to decide", () => {
    test("deny of a request whose paths are all gone closes it as gone", async () => {
        // The caller this process runs as, so the deny is the asker's own wherever the test runs.
        const caller = rmCallerFromRuntime();
        const request = createRmRequest({
            kind: "delete",
            caller,
            cwd: base,
            reason: null,
            targets: [{ path: join(base, "never-there.txt"), kind: "file", rule: "default", reason: "r" }],
        });
        const exitCode = process.exitCode;

        try {
            await createRmProgram().parseAsync(["deny", request.id], { from: "user" });
            expect(loadRmRequest(request.id)?.status).toBe("gone");
            expect(process.exitCode ?? 0).toBe(0);
        } finally {
            process.exitCode = exitCode;
        }
    });

    test("a deny whose aside copy is gone reports it lost, waits for nothing, and logs it", () => {
        const request = asideRequest("copy-lost");
        const [lost, kept] = request.targets;

        if (!lost?.stored || !kept) {
            throw new Error("expected two aside copies");
        }

        renameSync(lost.stored, join(base, "copy-lost-elsewhere.txt"));
        const result = denyRequest(request, { caller: PERSON, via: "cli" });

        expect(result.lost.map((target) => target.path)).toEqual([lost.path]);
        expect(result.waiting).toEqual([]);
        expect(result.back.returned).toEqual([kept.path]);
        expect(loadRmRequest(request.id)?.status).toBe("denied");
        expect(
            readRmLedger().filter((entry) => entry.action === "lost" && entry.requestId === request.id)
        ).toMatchObject([{ path: lost.path }]);
    });
});

describe("an aside copy deleted outside tools rm (macOS tmp_cleaner)", () => {
    const CAUSE = "deleted outside tools rm, by macOS tmp_cleaner or a person";

    /** Runs `args` as `tools rm ...` and returns what it printed, without colours. */
    async function run(args: string[]): Promise<string> {
        const printed: string[] = [];
        const println = spyOn(out, "println").mockImplementation((raw?: unknown) => {
            printed.push(stripAnsi(String(raw ?? "")));
        });

        try {
            await createRmProgram().parseAsync(args, { from: "user" });
        } finally {
            println.mockRestore();
        }

        return printed.join("\n");
    }

    /** Takes the aside copy of `target` away, as the cleaner does (renamed out of reach instead of deleted). */
    function clean(stored: string | undefined, name: string): void {
        renameSync(stored ?? "", join(base, `${name}-cleaned`));
    }

    test("requests names the request and the lost path, and approve closes it as gone without failing", async () => {
        const request = asideRequest("tmp-cleaned");
        const [first, second] = request.targets;

        if (!first?.stored || !second?.stored) {
            throw new Error("expected two aside copies");
        }

        clean(first.stored, "tmp-cleaned-a");
        clean(second.stored, "tmp-cleaned-b");
        const exitCode = process.exitCode;

        try {
            const list = await run(["requests"]);
            const row = list.split("\n").find((line) => line.trimStart().startsWith(request.id)) ?? "";
            expect(row).toContain("copy lost");
            expect(list).toContain(`copy lost = the set-aside copy is gone: ${CAUSE}`);

            const detail = await run(["requests", request.id]);
            expect(detail).toContain(`gone: ${CAUSE} (it waited at ${first.stored})`);
            expect(detail).not.toContain(`stored at ${first.stored}`);

            const approve = await run(["approve", request.id]);
            expect(approve).toContain(`gone ${first.path}: its set-aside copy was ${CAUSE}`);
            expect(approve).toContain(`gone ${second.path}: its set-aside copy was ${CAUSE}`);
            expect(loadRmRequest(request.id)?.status).toBe("gone");
            expect(process.exitCode ?? 0).toBe(0);
            expect(
                readRmLedger()
                    .filter((entry) => entry.action === "lost" && entry.requestId === request.id)
                    .map((entry) => entry.path)
            ).toEqual([first.path, second.path]);
        } finally {
            process.exitCode = exitCode;
        }
    });

    test("an approval moves the copies that are left and closes the request with the lost one reported", async () => {
        const request = asideRequest("tmp-cleaned-half");
        const [lost, kept] = request.targets;

        if (!lost?.stored || !kept?.stored) {
            throw new Error("expected two aside copies");
        }

        clean(lost.stored, "tmp-cleaned-half");
        const shown: string[] = [];
        const exitCode = process.exitCode;

        try {
            await approveMany([request.id], context(), {
                ask: async (_ctx, prompt) => {
                    shown.push(...(prompt.request?.items.map((item) => item.path) ?? []));
                    return {
                        approved: true,
                        via: "touch-id",
                        choices: { selected: null, disposal: "trash", remember: "once", note: null },
                        deniedByPerson: false,
                    };
                },
                kickDrainer: () => undefined,
            });
            const saved = loadRmRequest(request.id);

            expect(shown).toEqual([kept.path]);
            expect(saved?.status).toBe("approved");
            expect(saved?.decided?.approved).toEqual([kept.path]);
            expect(existsSync(kept.stored)).toBe(false);
            expect(process.exitCode ?? 0).toBe(0);
        } finally {
            process.exitCode = exitCode;
        }
    });
});

describe("every batch of a request", () => {
    const answer: PersonAnswer = {
        approved: true,
        via: "touch-id",
        choices: { selected: null, disposal: "trash", remember: "once", note: null },
        deniedByPerson: false,
    };

    test("a request approved in two steps keeps both batches, the newest in batchId", () => {
        const targets = ["a.txt", "b.txt"].map((name) => ({
            path: join(base, "two-steps", name),
            kind: "file" as const,
            rule: "default",
            reason: "no rule allows it",
        }));
        const request = createRmRequest({ kind: "delete", caller: AGENT, cwd: base, reason: null, targets });
        const second = request.targets[1];

        if (!second) {
            throw new Error("expected two targets");
        }

        saveApproved({
            request,
            answer,
            approved: [],
            denied: [],
            pending: [second],
            batchId: "20261101-100000-1-aaaa",
            ctx: context(),
        });
        const partly = loadRmRequest(request.id);

        if (!partly) {
            throw new Error("expected the request to stay pending");
        }

        saveApproved({
            request: partly,
            answer,
            approved: [],
            denied: [],
            pending: [],
            batchId: "20261101-110000-1-bbbb",
            ctx: context(),
        });
        const done = loadRmRequest(request.id);

        expect(done?.status).toBe("approved");
        expect(done ? requestBatchIds(done) : []).toEqual(["20261101-100000-1-aaaa", "20261101-110000-1-bbbb"]);
        expect(done?.batchId).toBe("20261101-110000-1-bbbb");
    });

    test("a request saved before batchIds reads its one batch", () => {
        expect(requestBatchIds({ batchId: "20261031-170802-1-6ce5" })).toEqual(["20261031-170802-1-6ce5"]);
        expect(requestBatchIds({})).toEqual([]);
    });
});

describe("a path that came back beside its aside copy", () => {
    test("approve offers to delete the set-aside copy and leaves the path that came back", async () => {
        const request = asideRequest("came-back");
        const [back] = request.targets;

        if (!back?.stored) {
            throw new Error("expected an aside copy");
        }

        file(back.path);
        // A deny cannot put the copy back over the path that came back: the request waits for it.
        expect(denyRequest(request, { caller: PERSON, via: "cli" }).waiting.map((target) => target.path)).toEqual([
            back.path,
        ]);
        const waiting = loadRmRequest(request.id);

        if (!waiting) {
            throw new Error("expected the request to wait");
        }

        const stop = new AbortController();
        stop.abort();
        const rows = approvalRows(waiting, entriesOf(waiting), { signal: stop.signal });
        await rows.done;
        expect(rows.items.map((item) => item.reason)).toEqual([
            "Delete the set-aside copy (the path is back in place)",
        ]);

        const { approved, denied } = splitBySelection(entriesOf(waiting), null);
        approveDelete({
            ctx: context(),
            request: waiting,
            approved,
            denied,
            choices: { selected: null, disposal: "trash", remember: "once", note: null },
        });
        expect(existsSync(back.path)).toBe(true);
        expect(existsSync(back.stored)).toBe(false);
    });
});

describe("the request writes production runs", () => {
    const answer: PersonAnswer = {
        approved: true,
        via: "touch-id",
        choices: { selected: null, disposal: "trash", remember: "once", note: null },
        deniedByPerson: false,
    };

    test("a partial approval keeps an initially blocked aside target pending and its folder guarded", () => {
        const request = asideRequest("partial-approval");
        const [blocked, approved] = request.targets;

        if (!blocked || !approved) {
            throw new Error("expected two aside copies");
        }

        saveApproved({ request, answer, approved: [], denied: [], pending: [blocked], ctx: context() });
        const saved = loadRmRequest(request.id);
        expect(saved?.status).toBe("pending");
        expect(saved?.targets).toEqual([blocked]);
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);

        if (!saved) {
            throw new Error("expected the request to stay pending");
        }

        saveApproved({ request: saved, answer, approved: [], denied: [], pending: [], ctx: context() });
        expect(loadRmRequest(request.id)?.status).toBe("approved");
    });

    test("a copy that cannot go home keeps the request pending, and a second deny closes it once the path is free", () => {
        const request = asideRequest("deny-kept");
        const [kept, other] = request.targets;

        if (!kept || !other) {
            throw new Error("expected two aside copies");
        }

        file(kept.path);
        const first = denyRequest(request, { caller: AGENT, via: "cli" });
        expect(first.waiting.map((target) => target.path)).toEqual([kept.path]);
        expect(first.back.returned).toEqual([other.path]);
        expect(loadRmRequest(request.id)?.status).toBe("pending");
        expect(pendingAsideDirs().some((entry) => entry.requestId === request.id)).toBe(true);

        renameSync(kept.path, `${kept.path}.agent-copy`);
        const again = denyRequest(loadRmRequest(request.id) ?? request, { caller: AGENT, via: "cli" });
        expect(again.back.returned).toEqual([kept.path]);
        expect(loadRmRequest(request.id)?.status).toBe("denied");
    });
});

describe("one window for several requests", () => {
    /** An in-place delete request for `paths`, each a fresh file under `folder`. */
    function inPlaceAsk(folder: string, names: string[]): RmRequest {
        const targets = names.map((name) => ({
            path: file(join(base, folder, name)),
            kind: "file" as const,
            rule: "default",
            reason: "no rule allows it",
        }));
        return createRmRequest({ kind: "delete", caller: AGENT, cwd: base, reason: null, targets });
    }

    /** A person who answers `selected` (null: every row) and records what the window showed. */
    function person(prompts: ApprovalPrompt[], selected: string[] | null = null, during?: () => void) {
        return async (_ctx: RunContext, prompt: Pick<ApprovalPrompt, "title" | "lines" | "request">) => {
            prompts.push({ ...prompt, code: "", caller: PERSON });
            during?.();
            return {
                approved: true,
                via: "touch-id",
                choices: { selected, disposal: "trash" as const, remember: "once" as const, note: null },
                deniedByPerson: false,
            };
        };
    }

    async function batch(ids: string[], ask: ReturnType<typeof person>): Promise<void> {
        const exitCode = process.exitCode;

        try {
            await approveMany(ids, context(), { ask, kickDrainer: () => undefined });
        } finally {
            process.exitCode = exitCode;
        }
    }

    test("an in-place path two requests name is one row, and both requests end approved", async () => {
        const first = inPlaceAsk("batch-shared", ["shared.txt"]);
        const shared = first.targets[0]?.path ?? "";
        const second = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: base,
            reason: null,
            targets: [{ path: shared, kind: "file", rule: "default", reason: "no rule allows it" }],
        });
        const prompts: ApprovalPrompt[] = [];
        await batch([second.id, first.id], person(prompts));

        expect(prompts).toHaveLength(1);
        expect(prompts[0]?.request?.items.map((item) => item.path)).toEqual([shared]);
        expect(loadRmRequest(first.id)?.status).toBe("approved");
        expect(loadRmRequest(second.id)?.status).toBe("approved");
        expect(existsSync(shared)).toBe(false);
    });

    test("a Deny reaches a request whose only path is the shared row another request owns", async () => {
        const first = inPlaceAsk("batch-deny-shared", ["shared.txt"]);
        const shared = first.targets[0]?.path ?? "";
        const second = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: base,
            reason: null,
            targets: [{ path: shared, kind: "file", rule: "default", reason: "no rule allows it" }],
        });
        const prompts: ApprovalPrompt[] = [];
        const deny: ReturnType<typeof person> = async (_ctx, prompt) => {
            prompts.push({ ...prompt, code: "", caller: PERSON });
            return {
                approved: false,
                via: "touch-id",
                choices: { selected: null, disposal: "trash", remember: "once", note: null },
                deniedByPerson: true,
            };
        };
        await batch([first.id, second.id], deny);

        expect(prompts[0]?.request?.items.map((item) => item.path)).toEqual([shared]);
        expect([first.id, second.id].map((id) => loadRmRequest(id)?.status)).toEqual(["denied", "denied"]);
        expect(existsSync(shared)).toBe(true);
    });

    test("an unticked shared row denies that path in every request that names it", async () => {
        const first = inPlaceAsk("batch-untick-shared", ["shared.txt", "own.txt"]);
        const [shared, own] = first.targets.map((target) => target.path);
        const second = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: base,
            reason: null,
            targets: [{ path: shared ?? "", kind: "file", rule: "default", reason: "no rule allows it" }],
        });
        const prompts: ApprovalPrompt[] = [];
        await batch([first.id, second.id], person(prompts, [own ?? ""]));

        expect(prompts[0]?.request?.items.map((item) => item.path).sort()).toEqual([own, shared].sort());
        expect(loadRmRequest(first.id)?.status).toBe("approved");
        expect(loadRmRequest(first.id)?.decided?.denied).toEqual([shared]);
        expect(loadRmRequest(second.id)?.status).toBe("denied");
        expect([shared, own].map((path) => existsSync(path ?? ""))).toEqual([true, false]);
    });

    test("a request made while the window is open is not touched", async () => {
        const asked = inPlaceAsk("batch-fixed", ["one.txt"]);
        const other = inPlaceAsk("batch-fixed", ["two.txt"]);
        const late: RmRequest[] = [];
        const prompts: ApprovalPrompt[] = [];
        await batch(
            [asked.id, other.id],
            person(prompts, null, () => {
                late.push(inPlaceAsk("batch-late", ["late.txt"]));
            })
        );

        expect(late).toHaveLength(1);
        expect(late.map((request) => loadRmRequest(request.id)?.status)).toEqual(["pending"]);
        expect(late.map((request) => existsSync(request.targets[0]?.path ?? ""))).toEqual([true]);
        expect(loadRmRequest(asked.id)?.status).toBe("approved");
    });

    test("a request open in another window is left out and stays pending", async () => {
        const free = inPlaceAsk("batch-busy", ["free.txt"]);
        const busy = inPlaceAsk("batch-busy", ["busy.txt"]);
        writeFileSync(rmRequestLockFile(busy.id), String(process.ppid));
        const prompts: ApprovalPrompt[] = [];

        try {
            await batch([free.id, busy.id], person(prompts));
        } finally {
            renameSync(rmRequestLockFile(busy.id), join(base, "busy-lock-moved"));
        }

        expect(prompts[0]?.request?.items.map((item) => item.path)).toEqual(free.targets.map((t) => t.path));
        expect(loadRmRequest(busy.id)?.status).toBe("pending");
        expect(existsSync(busy.targets[0]?.path ?? "")).toBe(true);
    });

    test("ticking one row of each request approves only that row in each", async () => {
        const first = inPlaceAsk("batch-pick-a", ["a1.txt", "a2.txt"]);
        const second = inPlaceAsk("batch-pick-b", ["b1.txt", "b2.txt"]);
        const [a1, a2] = first.targets.map((target) => target.path);
        const [b1, b2] = second.targets.map((target) => target.path);
        const prompts: ApprovalPrompt[] = [];
        await batch([first.id, second.id], person(prompts, [a1 ?? "", b1 ?? ""]));

        expect(prompts[0]?.title).toBe("Delete 4 items from 2 requests?");
        expect(loadRmRequest(first.id)?.decided?.approved).toEqual([a1]);
        expect(loadRmRequest(second.id)?.decided?.approved).toEqual([b1]);
        expect([a1, a2, b1, b2].map((path) => existsSync(path ?? ""))).toEqual([false, true, false, true]);
    });

    test("a ticked path replaced while the window is open stays, and its request stays pending", async () => {
        const first = inPlaceAsk("batch-swap-a", ["swapped.txt"]);
        const second = inPlaceAsk("batch-swap-b", ["kept.txt"]);
        const swapped = first.targets[0]?.path ?? "";
        const prompts: ApprovalPrompt[] = [];
        await batch(
            [first.id, second.id],
            person(prompts, null, () => {
                // A build replaces the file the person was shown with a new one (another inode).
                renameSync(swapped, `${swapped}.shown`);
                writeFileSync(swapped, "new");
            })
        );

        expect(existsSync(swapped)).toBe(true);
        expect(existsSync(`${swapped}.shown`)).toBe(true);
        expect(loadRmRequest(first.id)?.status).toBe("pending");
        expect(loadRmRequest(second.id)?.status).toBe("approved");
    });

    test("an aside copy and an in-place path of one name are never two rows of one window", async () => {
        const folder = join(base, "batch-mixed");
        const path = file(join(folder, "same.txt"));
        const verdict = { kind: "ask" as const, rule: "default", reason: "no rule allows it" };
        const aside = moveAside({
            inputs: [{ target: resolveTarget(path, base), verdict }],
            caller: AGENT,
            batchId: newBatchId(),
            root: join(base, "aside", "batch-mixed"),
        });
        const cameBackRequest = createRmRequest({
            kind: "delete",
            caller: AGENT,
            cwd: folder,
            reason: null,
            targets: aside.moved,
            asideDir: aside.dir,
        });
        const copy = cameBackRequest.targets[0]?.stored ?? "";
        // The path came back beside the copy, and another session asks for the new one in place. Its id sorts last,
        // so the came-back row is the one the window shows.
        file(path);
        const inPlace: RmRequest = {
            id: "zzzzzzzz",
            kind: "delete",
            createdAt: new Date().toISOString(),
            caller: { ...AGENT, sessionId: "sess-3333" },
            cwd: base,
            reason: null,
            targets: [{ path, kind: "file", rule: "default", reason: "no rule allows it" }],
            status: "pending",
        };
        saveRmRequest(inPlace);
        const lines: string[] = [];
        const println = spyOn(out, "println").mockImplementation((raw?: unknown) => {
            lines.push(stripAnsi(String(raw ?? "")));
        });
        const prompts: ApprovalPrompt[] = [];

        try {
            await batch([cameBackRequest.id, inPlace.id], person(prompts, [path]));
        } finally {
            println.mockRestore();
        }

        expect(prompts[0]?.request?.items.map((item) => item.reason)).toEqual([
            "Delete the set-aside copy (the path is back in place)",
        ]);
        expect(lines).toContain("left out zzzzzzzz: another request here names the same path");
        expect(existsSync(path)).toBe(true);
        expect(existsSync(copy)).toBe(false);
        expect(loadRmRequest(inPlace.id)?.status).toBe("pending");
    });
});

describe("an agent's drain --now", () => {
    const own: RmCaller = { agent: "claude-code", sessionId: "sess-drain", isInAgent: true };
    const item = (rule: string) => ({ original: "/work/a", stored: "/t/a", kind: "file" as const, rule });

    test("ends the grace of this session's own batches only, never an approved one", () => {
        const other = { ...own, sessionId: "sess-other" };
        expect(agentMayDrainEarly({ caller: own, items: [item("default")] }, own)).toBe(true);
        expect(agentMayDrainEarly({ caller: other, items: [item("default")] }, own)).toBe(false);
        expect(agentMayDrainEarly({ caller: { ...own, agent: "codex" }, items: [item("default")] }, own)).toBe(false);
        // An approved batch carries the asking session as its caller and the grace the person picked.
        expect(agentMayDrainEarly({ caller: own, items: [item("approved k7m2qd")] }, own)).toBe(false);
        expect(agentMayDrainEarly({ caller: null, items: [item("default")] }, own)).toBe(false);
        expect(agentMayDrainEarly({ caller: own, items: [item("default")] }, { ...own, sessionId: null })).toBe(false);
    });

    test("a forced drain with the filter keeps another session's batch and an approved one", async () => {
        const paths = { batchesDir: join(base, "drain-filter", "batches"), lockPath: join(base, "drain-filter", "l") };
        const moved = (name: string, caller: RmCaller, rule: string) =>
            moveToTrash([{ target: resolveTarget(file(join(base, "drain-filter-src", name)), base), rule }], {
                config,
                caller,
                graceMinutes: 60,
                paths,
            })?.items[0]?.stored ?? "";
        const mine = moved("mine.txt", own, "default");
        const theirs = moved("theirs.txt", { ...own, sessionId: "sess-other" }, "default");
        const approved = moved("approved.txt", own, "approved k7m2qd");

        try {
            await drainDue({ config, paths, force: true, forceOnly: (batch) => agentMayDrainEarly(batch, own) });
            expect([mine, theirs, approved].map((stored) => existsSync(stored))).toEqual([false, true, true]);
        } finally {
            await drainDue({ config, paths, force: true });
        }

        expect([theirs, approved].map((stored) => existsSync(stored))).toEqual([false, false]);
    });
});

describe("prune -n", () => {
    test("a dry run leaves a dead run's aside journal as it is", async () => {
        const id = "dryjr1";
        // No pid on macOS or Linux reaches 999999 by default: the run that wrote the journal is dead.
        const journal = join(rmRequestsDir(), `${id}.json.moving-999999`);
        const draft: RmRequest = {
            id,
            kind: "delete",
            createdAt: new Date().toISOString(),
            caller: AGENT,
            cwd: base,
            reason: null,
            targets: [{ path: join(base, "dry-journal", "a.txt"), kind: "file", rule: "default", reason: "r" }],
            status: "pending",
        };
        mkdirSync(rmRequestsDir(), { recursive: true });
        writeFileSync(journal, SafeJSON.stringify(draft));
        const println = spyOn(out, "println").mockImplementation(() => undefined);

        try {
            await createRmProgram().parseAsync(["prune", "-n"], { from: "user" });
        } finally {
            println.mockRestore();
        }

        expect(existsSync(journal)).toBe(true);
        expect(loadRmRequest(id)).toBeNull();
        // The control: the journal is one a recovery saves, so the dry run above really held back.
        expect(recoverAsideJournals()).toContain(id);
        expect(loadRmRequest(id)?.status).toBe("pending");
    });
});

describe("a person denies from the picker", () => {
    test("another session's requests are denied after one person check, with the person's way and note", async () => {
        const asker: RmCaller = { agent: "claude-code", sessionId: "sess-4444", isInAgent: true };
        const requests = ["one.txt", "two.txt"].map((name) =>
            createRmRequest({
                kind: "delete",
                caller: asker,
                cwd: base,
                reason: null,
                targets: [
                    {
                        path: file(join(base, "picker-deny", name)),
                        kind: "file",
                        rule: "default",
                        reason: "no rule allows it",
                    },
                ],
            })
        );
        const asked: string[] = [];
        const exitCode = process.exitCode;

        try {
            await denyPicked(
                requests.map((request) => request.id),
                context(),
                {
                    ask: async (_ctx, prompt) => {
                        asked.push(prompt.title);
                        return {
                            approved: true,
                            via: "touch-id",
                            choices: { selected: null, disposal: "trash", remember: "once", note: null },
                            deniedByPerson: false,
                        };
                    },
                    note: async () => "these are fixtures, keep them",
                }
            );
        } finally {
            process.exitCode = exitCode;
        }

        expect(asked).toEqual(["Deny 2 request(s) from other sessions?"]);
        expect(requests.map((request) => loadRmRequest(request.id))).toMatchObject([
            { status: "denied", decidedVia: "touch-id", deniedNote: "these are fixtures, keep them" },
            { status: "denied", decidedVia: "touch-id", deniedNote: "these are fixtures, keep them" },
        ]);
        const paths = requests.flatMap((request) => request.targets.map((target) => target.path));
        expect(priorDenials(paths, "sess-4444", listRmRequests({ all: true })).map((denial) => denial.note)).toEqual([
            "these are fixtures, keep them",
            "these are fixtures, keep them",
        ]);
    });
});

describe("the request hint an agent reads", () => {
    test("its last line stands alone: the id, that the agent must not approve, and how to cancel", () => {
        const lines: string[] = [];
        const println = spyOn(out, "println").mockImplementation((raw?: unknown, ...rest: unknown[]) => {
            lines.push([raw, ...rest].map(String).join(" "));
        });

        try {
            printRequestHint("k7m2qd", 2);
        } finally {
            println.mockRestore();
        }

        const last = stripAnsi(lines.at(-1) ?? "");
        expect(last).toContain("rm request k7m2qd: 2 path(s) wait for the user.");
        expect(last).toContain("Do not run approve yourself.");
        expect(last).toContain(`! ${toolCommand("rm")} approve k7m2qd`);
        expect(last).toContain(`${toolCommand("rm")} deny k7m2qd`);
    });
});

describe("the trash view", () => {
    const now = new Date("2026-11-01T14:32:00.000Z");
    const minutes = (n: number) => new Date(now.getTime() + n * 60_000).toISOString();
    const caller = {
        agent: "claude-code",
        sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
        isInAgent: true,
        sessionTitle: "shop cleanup",
    };
    const batches = [
        {
            id: "20261101-153000-111-fc7b",
            createdAt: minutes(-30),
            drainAfter: minutes(26),
            caller,
            items: [
                {
                    original: "/work/shop/node_modules",
                    stored: "/t/1",
                    kind: "dir" as const,
                    rule: "preset",
                    bytes: 3 * 1024 * 1024,
                },
                {
                    original: "/work/shop/dist",
                    stored: "/t/2",
                    kind: "dir" as const,
                    rule: "preset",
                    bytes: 1024 * 1024,
                },
            ],
        },
        {
            id: "20261101-153500-222-a1c3",
            createdAt: minutes(-5),
            drainAfter: minutes(55),
            caller: null,
            items: [{ original: "/work/shop/.cache", stored: "/t/3", kind: "dir" as const, rule: "preset" }],
            incomplete: true as const,
        },
    ];

    test("prints the totals and next drain, one row per batch, and the undo and drain commands", () => {
        const lines = renderTrash(batches, { now }).map(stripAnsi);

        expect(lines[0]).toMatch(/^rm trash {2}2 batches · 3 items · 4\.0 MB · next drain \d\d:\d\d \(in 26 min\)$/);
        expect(lines[1]).toMatch(
            /^ {2}fc7b {2}\d\d:\d\d \(in 26 min\)\s+4\.0 MB {2}aaaaaaaa shop cleanup {2}2 items {2}\/work\/shop\/node_modules \+1$/
        );
        expect(lines[2]).toMatch(/^ {2}a1c3 {2}● incomplete: restore it\s+- {2}-\s+1 item {2}\/work\/shop\/\.cache$/);
        expect(lines.at(-1)).toBe(
            `Undo: ${toolCommand("rm")} restore <batch>   Drain now (a person): ${toolCommand("rm")} drain --now`
        );
        expect(renderTrash([], { now })).toEqual(["The trash is empty."]);
    });

    test("a batch id tail restores exactly one batch, and an ambiguous or short one is refused", () => {
        const ids = ["20261101-153000-111-fc7b", "20261101-160000-333-0fc7b", "20261101-153500-222-a1c3"];

        expect(batchSuffix(ids[2], ids)).toBe("a1c3");
        expect(batchSuffix(ids[0], ids)).toBe("-fc7b");
        expect(resolveBatchSuffix("a1c3", ids)).toEqual({ id: ids[2] });
        expect(resolveBatchSuffix(ids[0], ids)).toEqual({ id: ids[0] });
        expect(resolveBatchSuffix("fc7b", ids)).toEqual({ ambiguous: [ids[0], ids[1]] });
        expect(resolveBatchSuffix("c3", ids)).toBeNull();
        expect(resolveBatchSuffix("zzzz", ids)).toBeNull();
    });
});

describe("the log view", () => {
    const agent = {
        agent: "claude-code",
        sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
        isInAgent: true,
        sessionTitle: "shop cleanup",
        user: "alice",
    };
    const shell = { agent: "unknown", sessionId: null, isInAgent: false, user: "alice" };
    const at = (minute: number) => new Date(2026, 10, 1, 15, minute).toISOString();
    const drain = (minute: number, path: string) => ({
        at: at(minute),
        action: "drain" as const,
        path,
        batchId: "20261101-150000-111-fc7b",
        bytes: 1024 * 1024,
        caller: agent,
    });
    const entries = [
        drain(27, "/work/shop/a"),
        drain(27, "/work/shop/b"),
        drain(28, "/work/shop/c"),
        { at: at(30), action: "approve" as const, requestId: "k7m2qd", caller: agent, person: { via: "touch-id" } },
        {
            at: at(31),
            action: "restore" as const,
            path: "/work/shop/a",
            batchId: "20261101-150000-111-fc7b",
            caller: shell,
        },
    ];

    test("collapses a run that shares action, batch and caller, and prints each caller once", () => {
        const lines = renderLedger(entries, { cwd: "/elsewhere" }).map(stripAnsi);

        expect(lines).toEqual([
            "── 2026-11-01",
            'claude-code aaaaaaaa "shop cleanup"',
            "  15:27 drain    3 items 3.0 MB batch …fc7b",
            "person via touch-id (started from claude-code aaaaaaaa)",
            "  15:30 approve  request k7m2qd",
            "person",
            "  15:31 restore  /work/shop/a",
        ]);
        expect(lines.join("\n")).not.toContain("alice");
    });

    test("--each prints one row per entry", () => {
        const rows = renderLedger(entries, { cwd: "/work/shop", each: true })
            .map(stripAnsi)
            .filter((line) => line.startsWith("  "));

        expect(rows).toHaveLength(5);
        expect(rows[0]).toBe("  15:27 drain    1.0 MB a");
    });
});

describe("the settings views", () => {
    test("config prints one row per setting with its default and where the value comes from", () => {
        const defaults = defaultRmConfig();
        const base = { ...defaults, askAction: "request" as const };
        const effective = { ...base, grace: { ...base.grace, otherMinutes: 240 } };
        const lines = renderConfig({
            base,
            effective,
            profiles: ["workers"],
            defaults,
            path: "/home/shop/rm/config.json",
        }).map(stripAnsi);

        expect(lines[0]).toBe("/home/shop/rm/config.json");
        expect(lines[1]).toMatch(/^SETTING\s+VALUE\s+DEFAULT\s+FROM$/);
        expect(lines.find((line) => line.startsWith("ask-action"))).toMatch(/^ask-action\s+request\s+aside\s+file$/);
        expect(lines.find((line) => line.startsWith("grace-other"))).toMatch(
            /^grace-other\s+240 min\s+60 min\s+profile workers$/
        );
        expect(lines.find((line) => line.startsWith("approval"))).toMatch(/^approval\s+auto\s+auto\s+default$/);
        expect(lines.at(-1)).toBe(`Change (a person): ${toolCommand("rm")} config set <setting> <value>`);
    });

    test("presets print one row each with a state cell, home as ~, and the opt-in command once", () => {
        const home = "/home/shop";
        const all = [
            {
                id: "node_modules",
                description: "installed packages",
                names: ["node_modules"],
                markers: ["package.json"],
            },
            {
                id: "bun-cache",
                description: "bun's cache",
                names: [],
                within: "/home/shop/.bun/install/cache",
                optIn: true,
            },
            { id: "python", description: "bytecode", names: ["__pycache__"] },
        ];
        const lines = renderPresets({ all, enabled: new Set(["node_modules"]), disabled: ["python"], home }).map(
            stripAnsi
        );

        expect(lines[0]).toMatch(/^ID\s+STATE\s+DELETES\s+NEXT TO\s+WHAT$/);
        expect(lines[1]).toMatch(/^node_modules\s+● on\s+node_modules\s+next to package\.json\s+installed packages$/);
        expect(lines[2]).toMatch(/^bun-cache\s+● opt-in\s+every folder in ~\/\.bun\/install\/cache\s+-\s+bun's cache$/);
        expect(lines[3]).toMatch(/^python\s+● off\s+__pycache__/);
        expect(lines.filter((line) => line.includes("config set enable-preset"))).toHaveLength(1);
    });

    test("roots print a table with the scope and the local time they were added", () => {
        const lines = renderRoots(
            [{ path: "/home/shop/scratch", addedAt: "2026-11-01T12:00:00.000Z", via: "cli", note: "build output" }],
            "/home/shop"
        ).map(stripAnsi);

        expect(lines[0]).toMatch(/^PATH\s+SCOPE\s+ADDED\s+NOTE$/);
        expect(lines[1]).toMatch(/^~\/scratch\s+always\s+2026-11-01 \d\d:\d\d cli\s+build output$/);
        expect(renderRoots([], "/home/shop")[0]).toContain("roots add <dir>");
    });

    test("a profile's unset grace reads as configured, never as a dash", () => {
        expect(describePolicy({ grace: { otherMinutes: 240 } })).toContain(
            "grace: presets as configured, others 240 min"
        );
    });
});

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
import {
    createRmRequest,
    defaultRmConfig,
    defaultRuleContext,
    drainDue,
    isRootActive,
    listRmRequests,
    loadRmConfig,
    loadRmRequest,
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
    saveRmConfig,
    stillAside,
} from "@genesiscz/utils/rm";
import { saveApproved } from "../commands/requests";
import { applyRmSetting, saveRmSetting } from "../commands/settings";
import { type ApproveEntry, approveDelete, denyRequest, splitBySelection } from "./approve";
import type { RunContext } from "./run";

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

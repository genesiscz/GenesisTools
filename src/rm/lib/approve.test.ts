import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    newBatchId,
    pendingAsideDirs,
    priorDenials,
    type RmCaller,
    type RmConfig,
    type RmRequest,
    resolveTarget,
    saveRmConfig,
} from "@genesiscz/utils/rm";
import { saveApproved } from "../commands/requests";
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

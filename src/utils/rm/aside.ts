import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { appendRmLedger } from "./ledger";
import { DESTINATION_TAKEN, ensurePrivateDir, renameNoReplace, sharedTempRoot } from "./paths";
import { asideJournals } from "./pending-aside";
import {
    createRmRequest,
    type RmRequest,
    type RmRequestTarget,
    reserveRmRequestId,
    rmRequestsDir,
    saveRmRequest,
} from "./requests";
import type { RmCaller, RmTarget, RmVerdict } from "./rules";
import { agentScratchDir } from "./scratch-dirs";
import { newBatchId, type RenameHooks, RmTargetChangedError, renameVerified, trashItemName } from "./trash";

export { AGENT_SCRATCH_DIRS, agentScratchDir } from "./scratch-dirs";

/** The roots a session's scratch may live under: the shared `cc` convention and the agent's own folder. */
export function sessionScratchRoots(caller: RmCaller): string[] {
    return [...new Set([join(sharedTempRoot(), "cc"), join(sharedTempRoot(), agentScratchDir(caller.agent))])];
}

function segment(value: string | null | undefined, fallback: string): string {
    const clean = (value ?? "").replace(/[^\w.-]/g, "_").slice(0, 80);
    return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

/** `<tmp>/<agent dir>/<project>/<session>/rm-aside`: where this caller's paths wait for the user's decision. */
export function asideRootFor(caller: RmCaller): string {
    return join(
        sharedTempRoot(),
        agentScratchDir(caller.agent),
        segment(caller.project, "unknown-project"),
        segment(caller.sessionId, "no-session"),
        "rm-aside"
    );
}

export interface AsideInput {
    target: RmTarget;
    verdict: RmVerdict;
}

export interface AsideResult {
    dir: string;
    moved: RmRequestTarget[];
    /** Paths that stay where they are (on another volume, or the rename failed), with why. */
    kept: Array<{ input: AsideInput; reason: string }>;
}

export interface MoveAsideOptions {
    inputs: readonly AsideInput[];
    caller: RmCaller;
    batchId: string;
    /** The aside root; the caller's session scratch by default. */
    root?: string;
    /** Called once with every planned move (original and destination) before the first one moves. */
    beforeMoves?: (dir: string, planned: RmRequestTarget[]) => void;
    hooks?: RenameHooks;
}

/**
 * Renames each path into `<aside root>/<batch>/`, measuring it after the move. A path on another volume stays in
 * place (a copy is not a move aside), and so does one whose rename fails.
 */
export function moveAside(options: MoveAsideOptions): AsideResult {
    const { inputs, caller } = options;
    const root = options.root ?? asideRootFor(caller);
    const dir = join(root, options.batchId);
    const result: AsideResult = { dir, moved: [], kept: [] };

    try {
        // In the machine-wide /tmp: closed to other users, who could read what waits there or swap the folder.
        ensurePrivateDir(root, { ancestors: true });
    } catch (error) {
        const reason = `the aside folder is not private (${error instanceof Error ? error.message : String(error)})`;
        logger.warn({ root, error }, "rm: aside folder refused");
        result.kept.push(...inputs.map((input) => ({ input, reason })));
        return result;
    }

    const planned = inputs.map((input, index) => ({
        input,
        stored: join(dir, trashItemName(index, input.target.path)),
    }));
    options.beforeMoves?.(
        dir,
        planned.map(({ input, stored }) => ({ ...requestTarget(input), stored }))
    );

    for (const { input, stored } of planned) {
        try {
            mkdirSync(dirname(stored), { recursive: true });
            renameVerified(input.target, stored, options.hooks);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const reason =
                error instanceof RmTargetChangedError
                    ? error.message
                    : code === "EXDEV"
                      ? "on another volume than the aside folder"
                      : `the move failed (${code})`;
            logger.debug({ path: input.target.path, stored, error }, "rm: kept in place instead of aside");
            result.kept.push({ input, reason });
            continue;
        }

        // The size comes from the request's measurement pass (`tools rm measure`), so the asking run does not wait.
        result.moved.push({ ...requestTarget(input), stored });
        appendRmLedger({ action: "aside", path: input.target.path, stored, rule: input.verdict.rule, caller });
    }

    return result;
}

/** How a request names `input` where it is. */
function requestTarget(input: AsideInput): RmRequestTarget {
    return { path: input.target.path, kind: input.target.kind, rule: input.verdict.rule, reason: input.verdict.reason };
}

export interface AsideRequestInput {
    /** The paths that move into the session's aside folder while the user decides. */
    aside: readonly AsideInput[];
    /** The paths the request names where they are. */
    inPlace: readonly AsideInput[];
    caller: RmCaller;
    cwd: string;
    reason: string | null;
    requestsDir?: string;
    /** The aside root; the caller's session scratch by default. */
    root?: string;
    hooks?: RenameHooks;
}

export interface AsideRequestResult {
    request: RmRequest;
    /** Null when nothing was to move aside. */
    aside: AsideResult | null;
}

/**
 * Moves `aside` into the session's aside folder and opens one request for those and the `inPlace` paths. The
 * request is drafted first, as a journal this process holds (`<id>.json.moving-<pid>` beside the requests), with
 * every planned move and its restore path; the moves follow, then the request is saved and the journal removed. A
 * crash between moves leaves the journal: its folder stays guarded, and `recoverAsideJournals` opens the request.
 * No reader lists a journal as a request, older ones included, so nobody decides it while its paths still move.
 */
export function createAsideRequest(input: AsideRequestInput): AsideRequestResult {
    const dir = input.requestsDir ?? rmRequestsDir();
    const fields = { kind: "delete" as const, caller: input.caller, cwd: input.cwd, reason: input.reason };
    const inPlace = input.inPlace.map(requestTarget);

    if (input.aside.length === 0) {
        return { request: createRmRequest({ ...fields, targets: inPlace }, dir), aside: null };
    }

    const id = reserveRmRequestId(dir);
    const journal = join(dir, `${id}.json.moving-${process.pid}`);
    const aside = moveAside({
        inputs: input.aside,
        caller: input.caller,
        batchId: newBatchId(),
        root: input.root,
        hooks: input.hooks,
        beforeMoves: (asideDir, planned) => {
            const draft: RmRequest = {
                ...fields,
                id,
                createdAt: new Date().toISOString(),
                status: "pending",
                asideDir,
                targets: [...planned, ...inPlace],
            };
            mkdirSync(dir, { recursive: true });
            atomicWriteFileSync(journal, `${SafeJSON.stringify(draft, null, 2)}\n`);
        },
    });
    const request = createRmRequest(
        {
            ...fields,
            id,
            asideDir: aside.moved.length > 0 ? aside.dir : undefined,
            targets: [...aside.moved, ...inPlace, ...aside.kept.map((k) => requestTarget(k.input))],
        },
        dir
    );

    if (existsSync(journal)) {
        unlinkSync(journal);
    }

    return { request, aside };
}

/**
 * Opens the request of each aside run that died before it did, from its journal: a planned move whose copy is in
 * the aside folder keeps its stored path (deny puts it back, approve deletes it), one that never moved is named in
 * place. A journal whose request was saved is removed. A live run's journal, or one that cannot be read, stays and
 * keeps its folder guarded. Returns the ids of the requests it opened.
 */
export function recoverAsideJournals(requestsDir = rmRequestsDir()): string[] {
    const recovered: string[] = [];

    for (const journal of asideJournals(requestsDir)) {
        if (isProcessAlive(journal.pid)) {
            continue;
        }

        const draft = journal.draft;

        if (!draft) {
            logger.warn({ file: journal.file }, "rm: unreadable aside journal kept");
            continue;
        }

        if (!existsSync(join(requestsDir, `${journal.id}.json`))) {
            const targets = draft.targets.map((target) =>
                target.stored === undefined || existsSync(target.stored) || isLink(target.stored)
                    ? target
                    : { path: target.path, kind: target.kind, rule: target.rule, reason: target.reason }
            );
            const asideDir = targets.some((target) => target.stored !== undefined) ? draft.asideDir : undefined;
            saveRmRequest({ ...draft, targets, asideDir }, requestsDir);
            appendRmLedger({
                action: "request",
                requestId: journal.id,
                reason: "recovered: the run that moved its paths aside stopped before it opened the request",
                caller: draft.caller,
                path: targets.map((target) => target.path).join(", "),
            });
            logger.warn({ id: journal.id, pid: journal.pid }, "rm: request recovered from a dead aside run");
            recovered.push(journal.id);
        }

        unlinkSync(journal.file);
    }

    return recovered;
}

export interface ReturnResult {
    returned: string[];
    kept: Array<{ path: string; reason: string }>;
}

/** A seam for the test that recreates the original path between the check and the put-back. */
export interface ReturnHooks {
    beforeMove?: (path: string) => void;
}

/**
 * Moves aside items back to where they were (a denied request). The put-back never replaces anything: a path that
 * appeared there, even after the check, keeps its place and the aside copy keeps waiting.
 */
export function returnAside(
    targets: readonly RmRequestTarget[],
    caller: RmCaller | null,
    requestId: string,
    hooks: ReturnHooks = {}
): ReturnResult {
    const result: ReturnResult = { returned: [], kept: [] };

    for (const target of targets) {
        if (!target.stored) {
            continue;
        }

        if (!existsSync(target.stored) && !isLink(target.stored)) {
            result.kept.push({ path: target.path, reason: `the aside copy is gone (${target.stored})` });
            continue;
        }

        const taken = { path: target.path, reason: `something exists there now; it waits at ${target.stored}` };

        if (existsSync(target.path) || isLink(target.path)) {
            result.kept.push(taken);
            continue;
        }

        try {
            mkdirSync(dirname(target.path), { recursive: true });
            hooks.beforeMove?.(target.path);
            renameNoReplace(target.stored, target.path);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";

            if (DESTINATION_TAKEN.has(code)) {
                result.kept.push(taken);
                continue;
            }

            // Any other failure (a folder that cannot be written, another volume) leaves the copy aside, and the
            // caller keeps the request pending for it, instead of a throw that loses what already went back.
            const message = error instanceof Error ? error.message : String(error);
            logger.warn({ path: target.path, stored: target.stored, error }, "rm: put-back failed");
            result.kept.push({
                path: target.path,
                reason: `the put-back failed (${message}); it waits at ${target.stored}`,
            });
            continue;
        }

        result.returned.push(target.path);
        appendRmLedger({ action: "return", path: target.path, stored: target.stored, requestId, caller });
    }

    return result;
}

/**
 * An agent may cancel only its own request (same agent, same session); a person, outside any agent, may deny any.
 * Otherwise one session could put another's paths back and close the decision its user still has to make.
 */
export function mayDenyRmRequest(request: RmRequest, caller: RmCaller): boolean {
    if (!caller.isInAgent) {
        return true;
    }

    return (
        caller.sessionId !== null &&
        request.caller?.agent === caller.agent &&
        request.caller?.sessionId === caller.sessionId
    );
}

/**
 * The aside copies of `targets` that did not go back and still exist: the request must stay pending for them, so
 * their aside folder stays guarded. A copy that is gone has nothing left to guard.
 */
export function stillAside(targets: readonly RmRequestTarget[], back: ReturnResult): RmRequestTarget[] {
    const returned = new Set(back.returned);
    return targets.filter(
        (t) => t.stored !== undefined && !returned.has(t.path) && (existsSync(t.stored) || isLink(t.stored))
    );
}

function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

export { type PendingAside, pendingAsideDirs, pendingAsideFor } from "./pending-aside";

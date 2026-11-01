import { toolCommand } from "@genesiscz/utils/cli";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    appendRmLedger,
    approvalDenyReason,
    createRmRequest,
    hardDenyReason,
    kickDrainer,
    listRmRequests,
    loadRmMeasurementOf,
    loadRmRequest,
    lockRmRequest,
    mayDenyRmRequest,
    measureRmRequest,
    pruneRmRequests,
    type RmRequest,
    type RmRequestTarget,
    recheckAfterWait,
    recoverAsideJournals,
    rememberOptions,
    requestLive,
    resolveTarget,
    saveRmRequest,
    stillAside,
    updateRmRequest,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type ApproveEntry,
    approvalRequestInfo,
    approvalRows,
    approveDelete,
    approveRoots,
    type DenyOutcome,
    denyRequest,
    savedSizes,
    splitBySelection,
} from "../lib/approve";
import { buildRequestViews, renderRequestDetail, renderRequestList } from "../lib/requests-view";
import {
    minutesOption,
    type PersonAnswer,
    printRequestHint,
    type RunContext,
    requirePerson,
    runContext,
    shown,
} from "../lib/run";

function approvalLines(
    request: RmRequest,
    entries: readonly ApproveEntry[],
    ctx: RunContext,
    sizes: (number | undefined)[]
) {
    const lines = entries.map(({ wanted }, index) => {
        const bytes = sizes[index];
        const size = bytes === undefined ? "" : `  ${formatBytes(bytes)}`;
        const where = wanted.stored ? ", moved aside" : "";
        return `${shown(wanted.path, ctx.cwd)}${size}  (${wanted.reason}${where})`;
    });

    if (request.reason) {
        lines.unshift(`Why: ${request.reason}`, "");
    }

    return lines;
}

/**
 * Records the decision on the request: approved (with the ticked and the put-back paths) and its batch. A path that
 * was refused, changed while the person decided, or could not be moved keeps the request pending, with only those.
 */
export function saveApproved(input: {
    request: RmRequest;
    answer: PersonAnswer;
    approved: readonly ApproveEntry[];
    denied: readonly ApproveEntry[];
    pending: readonly RmRequestTarget[];
    batchId?: string;
    ctx: RunContext;
}): void {
    const { request, answer, approved, denied, pending, batchId, ctx } = input;
    saveRmRequest({
        ...request,
        status: pending.length > 0 ? "pending" : "approved",
        targets: pending.length > 0 ? request.targets.filter((target) => pending.includes(target)) : request.targets,
        decidedAt: new Date().toISOString(),
        decidedVia: answer.via,
        decided: {
            approved: [
                ...new Set([...(request.decided?.approved ?? []), ...approved.map((entry) => entry.wanted.path)]),
            ],
            denied: [...new Set([...(request.decided?.denied ?? []), ...denied.map((entry) => entry.wanted.path)])],
            disposal: request.kind === "delete" ? answer.choices.disposal : undefined,
            remember: request.kind === "delete" ? answer.choices.remember : undefined,
        },
        batchId: batchId ?? request.batchId,
    });
    appendRmLedger({ action: "approve", requestId: request.id, via: answer.via, caller: ctx.caller, batchId });
}

function exitPendingFor(id: string, pending: readonly RmRequestTarget[]): void {
    if (pending.length === 0) {
        return;
    }

    out.println(
        pc.yellow(`Request ${id} stays pending for ${pending.length} blocked, changed or not put back path(s).`)
    );
    process.exitCode = 1;
}

interface RequestsFlags {
    all?: boolean;
    json?: boolean;
    long?: boolean;
    paths?: boolean;
    session?: string;
    agent?: string;
    project?: string;
    older?: number;
    sort?: "age" | "size";
}

function sortOption(value: string): "age" | "size" {
    if (value === "age" || value === "size") {
        return value;
    }

    throw new Error(`--sort takes age or size, not ${value}`);
}

/** The requests the flags pick: the same filters as `tools rm log`, plus an age floor. */
function pickRequests(flags: RequestsFlags, now: Date): RmRequest[] {
    return listRmRequests({ all: flags.all, now }).filter((request) => {
        const caller = request.caller;
        const ageMinutes = (now.getTime() - Date.parse(request.createdAt)) / 60_000;
        return (
            (!flags.session || (caller?.sessionId ?? "").startsWith(flags.session)) &&
            (!flags.agent || (caller?.agent ?? "person") === flags.agent) &&
            (!flags.project || caller?.project === flags.project) &&
            (flags.older === undefined || ageMinutes >= flags.older)
        );
    });
}

/** The size a listing shows for a path: the measurement pass's number, else the one an older aside move recorded. */
function listedSize(request: RmRequest, target: RmRequestTarget): number | undefined {
    return loadRmMeasurementOf(request.id, target)?.bytes ?? target.bytes;
}

/** Runs `decide` while this process holds request `id`'s decision lock; a busy request prints `busyLine` and returns false. */
export async function underDecisionLock(
    id: string,
    busyLine: (holder: number | null) => string,
    decide: () => Promise<void> | void
): Promise<boolean> {
    const lock = lockRmRequest(id);

    if (!lock.ok) {
        out.println(pc.yellow(busyLine(lock.holder)));
        return false;
    }

    try {
        await decide();
        return true;
    } finally {
        lock.release();
    }
}

/** `tools rm approve <id>`: shows the request to a person and does what they picked; the caller holds its lock. */
async function approveOne(id: string, ctx: RunContext): Promise<void> {
    const request = loadRmRequest(id);

    if (!request || request.status !== "pending") {
        out.println(pc.red(request ? `Request ${id} is ${request.status}.` : `No request ${id}.`));
        process.exitCode = 1;
        return;
    }

    if (requestLive(request).state === "gone") {
        out.println(
            `Nothing left to decide: request ${id} is gone (its paths were moved or deleted). Close it: ${toolCommand("rm")} prune`
        );
        return;
    }

    // A path the person already denied whose aside copy could not go home waits for a deny, not a second
    // approval; a path that was blocked or changed while they decided can be approved again.
    const deniedBefore = new Set(request.decided?.denied ?? []);

    if (request.targets.some((target) => deniedBefore.has(target.path))) {
        out.println(
            pc.red(`Request ${id} has unfinished recovery. Use ${toolCommand("rm")} deny ${id} to retry the put-back.`)
        );
        process.exitCode = 1;
        return;
    }

    // An aside item is approved where it waits (its stored copy); the original path is what gets recorded.
    const entries: ApproveEntry[] = request.targets.map((t) => ({
        wanted: t,
        target: resolveTarget(t.stored ?? t.path, request.cwd),
    }));
    // A root is trusted, not deleted: only the hard-deny rules apply to it, not the worktree ones.
    const denyOf = request.kind === "root" ? hardDenyReason : approvalDenyReason;
    const blocked = entries
        .map((e) => ({ ...e, denied: denyOf(e.target, ctx.rules) }))
        .filter((e) => e.denied !== null);
    const openEntries = entries.filter((e) => !blocked.some((b) => b.wanted === e.wanted));

    for (const entry of blocked) {
        out.println(pc.red(`refuse ${entry.wanted.path}: ${entry.denied}`));
    }

    if (openEntries.length === 0) {
        out.println(pc.red(`Nothing to approve in ${id}: every path was refused above.`));
        process.exitCode = 1;
        return;
    }

    // The window opens now; the sizes not saved yet follow into it as they are measured.
    const measuring = new AbortController();
    const rows = approvalRows(request, openEntries, { signal: measuring.signal });
    const info = approvalRequestInfo(request, rows.items);
    const who = info.asker ? (info.asker.session ?? info.asker.project ?? info.asker.agent) : "an agent";
    const verb =
        request.kind === "delete"
            ? `Delete ${openEntries.length === 1 ? "1 item" : `${openEntries.length} items`}`
            : `Trust ${shown(openEntries[0]?.target.path ?? "", ctx.cwd)}`;
    out.println(pc.dim(`Opening the approval window for ${id} (${openEntries.length} item(s))…`));
    const answer = await requirePerson(ctx, {
        title: `${verb} for ${who}?`,
        lines: approvalLines(
            request,
            openEntries,
            ctx,
            rows.items.map((item) => item.bytes)
        ),
        code: id,
        request: info,
        remember: rememberOptions(request.kind, request.caller),
        updates: rows.updates,
    }).finally(() => measuring.abort());

    if (!answer.approved) {
        if (answer.deniedByPerson) {
            const outcome = denyRequest(request, {
                caller: ctx.caller,
                via: answer.via,
                note: answer.choices.note,
            });
            printDenyOutcome(id, outcome, `Request ${id} denied.`);
        }

        return;
    }

    const { approved, denied } = splitBySelection(openEntries, answer.choices.selected);

    if (approved.length === 0) {
        const outcome = denyRequest(request, { caller: ctx.caller, via: answer.via, note: answer.choices.note });
        printDenyOutcome(id, outcome, `Nothing was ticked: request ${id} denied.`);
        return;
    }

    // The prompt can wait for minutes: each ticked path must still name what the person was shown, and still
    // pass the rules no approval overrides. A changed one stays in the request, which stays pending for it, as
    // do the paths refused before the prompt.
    const pending: RmRequestTarget[] = blocked.map((entry) => entry.wanted);
    const ready = approved.filter(({ wanted, target }) => {
        const reason = recheckAfterWait(target, ctx.rules, denyOf);

        if (reason) {
            out.println(pc.red(`refuse ${wanted.path}: ${reason}`));
            pending.push(wanted);
        }

        return reason === null;
    });

    if (ready.length === 0) {
        process.exitCode = 1;
        return;
    }

    if (request.kind === "root") {
        approveRoots(ctx, request, ready, answer.via);
        saveApproved({ request, answer, approved: ready, denied, pending, ctx });
        exitPendingFor(id, pending);
        return;
    }

    const { batch, back } = approveDelete({
        ctx,
        request,
        approved: ready,
        denied,
        choices: answer.choices,
        onRefused: (entry) => pending.push(entry.wanted),
        sizes: savedSizes(request, ready),
    });
    const moved = ready.filter((entry) => !pending.includes(entry.wanted));
    // An unticked aside copy that could not go home stays pending, so its aside folder stays guarded.
    pending.push(
        ...stillAside(
            denied.map((entry) => entry.wanted),
            back
        )
    );
    saveApproved({ request, answer, approved: moved, denied, pending, batchId: batch?.id, ctx });
    kickDrainer(ctx.config);
    exitPendingFor(id, pending);
}

/** `tools rm deny <id>`: closes a request and puts its aside copies back; the caller holds its lock. */
function denyOne(id: string, ctx: RunContext): void {
    const request = loadRmRequest(id);

    if (!request || request.status !== "pending") {
        out.println(pc.red(request ? `Request ${id} is ${request.status}.` : `No request ${id}.`));
        process.exitCode = 1;
        return;
    }

    if (!mayDenyRmRequest(request, ctx.caller)) {
        out.println(pc.red(`Request ${id} belongs to another session: only the user may deny it.`));
        process.exitCode = 1;
        return;
    }

    // Nothing is left to put back: close it the way prune does, as gone, not as a deny.
    if (requestLive(request).state === "gone") {
        const update = updateRmRequest(id, (fresh) =>
            fresh.status === "pending"
                ? { ...fresh, status: "gone", decidedAt: new Date().toISOString(), decidedVia: "cli" }
                : null
        );

        if (update.kind !== "saved") {
            out.println(pc.red(`Request ${id} could not be closed (${update.kind}).`));
            process.exitCode = 1;
            return;
        }

        appendRmLedger({ action: "close", requestId: id, reason: "gone", caller: ctx.caller });
        out.println(`Request ${id} closed: nothing was left.`);
        process.exitCode = 0;
        return;
    }

    const outcome = denyRequest(request, { caller: ctx.caller, via: "cli" });
    printDenyOutcome(id, outcome, `Request ${id} closed.`);
    process.exitCode = outcome.waiting.length > 0 ? 1 : 0;
}

/** Prints what a deny did: the copies that were already gone, then the closed line, or that some copies still wait. */
function printDenyOutcome(id: string, outcome: DenyOutcome, closedLine: string): void {
    if (outcome.lost.length > 0) {
        const paths = outcome.lost.map((target) => target.path).join(", ");
        out.println(pc.yellow(`${outcome.lost.length} set-aside copy(ies) were already gone: ${paths}`));
    }

    if (outcome.waiting.length > 0) {
        out.println(`Request ${id} still needs recovery.`);
        process.exitCode = 1;
        return;
    }

    out.println(closedLine);
}

export function registerRequestCommands(program: Command): void {
    program
        .command("requests")
        .description("the requests agents made for the user to confirm")
        .argument("[id]", "one request in full: every path, its stored copy, its reason and the decision so far")
        .option("--all", "also approved, denied, expired and gone ones")
        .option("--json", "print the saved requests as JSON")
        .option("--long", "the full form of every listed request")
        .option("--paths", "one row per path")
        .option("--session <id>", "a session id or its prefix")
        .option("--agent <name>", "claude-code, codex, grok, copilot, or person")
        .option("--project <name>", "the project folder name")
        .option("--older <duration>", "only requests older than 30m, 2h, 1d, ...", minutesOption)
        .option("--sort <key>", "a flat list by age or size instead of groups per session", sortOption)
        .action((id: string | undefined, flags: RequestsFlags) => {
            const ctx = runContext();
            const now = new Date();

            if (id) {
                const request = loadRmRequest(id);

                if (!request) {
                    out.println(pc.red(`No request ${id}.`));
                    process.exitCode = 1;
                    return;
                }

                if (flags.json) {
                    out.result(request);
                    return;
                }

                const [view] = buildRequestViews([request], { sizeOf: listedSize });
                out.println(view ? renderRequestDetail(view, now).join("\n") : "");
                return;
            }

            const requests = pickRequests(flags, now);

            if (flags.json) {
                out.result(requests);
                return;
            }

            if (requests.length === 0) {
                out.println(flags.all ? "No requests." : "No pending requests.");
                return;
            }

            const views = buildRequestViews(requests, { sizeOf: listedSize });

            if (flags.long) {
                out.println(views.map((view) => renderRequestDetail(view, now).join("\n")).join("\n\n"));
                return;
            }

            out.println(
                renderRequestList(views, { now, caller: ctx.caller, sort: flags.sort, paths: flags.paths }).join("\n")
            );
        });

    program
        .command("request-root")
        .description("ask the user to trust a folder: an agent may then delete anything inside it")
        .argument("<dir>", "the folder")
        .requiredOption("--reason <text>", "why the agent needs it")
        .action((dir: string, flags: { reason: string }) => {
            const ctx = runContext();
            const target = resolveTarget(dir, ctx.cwd);
            const denied = hardDenyReason(target, ctx.rules);

            if (target.kind !== "dir" || denied) {
                out.println(pc.red(`Cannot be a root: ${denied ?? "not a folder"}.`));
                process.exitCode = 1;
                return;
            }

            const request = createRmRequest({
                kind: "root",
                caller: ctx.caller,
                cwd: ctx.cwd,
                reason: flags.reason,
                targets: [{ path: target.canonical, kind: "dir", rule: "root", reason: "trust this folder" }],
            });
            printRequestHint(request.id, 1);
            process.exitCode = 3;
        });

    program
        .command("approve")
        .description(
            "confirm an agent's request (a person only: Touch ID through GenesisTools.app, a typed code, or a macOS dialog)"
        )
        .argument("<id>", "the request id")
        .action(async (id: string) => {
            const ctx = runContext();
            recoverAsideJournals();
            await underDecisionLock(
                id,
                (holder) =>
                    `Request ${id} is open in an approval window${holder ? ` (pid ${holder})` : ""}. Answer that window.`,
                () => approveOne(id, ctx)
            );
        });

    program
        .command("measure")
        .description(
            `measure a delete request's paths and save the sizes with it (${toolCommand("rm")} starts this in the background)`
        )
        .argument("<id>", "the request id")
        .action(async (id: string) => {
            const result = await measureRmRequest(id);
            out.println(
                result.busy
                    ? `Request ${id} is measured by another run.`
                    : `Measured ${result.measured} path(s) of request ${id}; ${result.fresh} were still fresh.`
            );
        });

    program
        .command("deny")
        .description("close a request without doing it (an agent may cancel its own)")
        .argument("<id>", "the request id")
        .action(async (id: string) => {
            const ctx = runContext();
            recoverAsideJournals();
            const done = await underDecisionLock(
                id,
                (holder) => `Request ${id} is being decided in another window${holder ? ` (pid ${holder})` : ""}.`,
                () => denyOne(id, ctx)
            );

            if (!done) {
                process.exitCode = 1;
            }
        });

    program
        .command("prune")
        .description("close the requests nobody can decide: every path gone, or in place past 24 h (moves no file)")
        .option("-n, --dry-run", "list what would close")
        .option("--json", "print as JSON")
        .action((flags: { dryRun?: boolean; json?: boolean }) => {
            const ctx = runContext();
            recoverAsideJournals();
            const result = pruneRmRequests({ dryRun: flags.dryRun, caller: ctx.caller });

            if (flags.json) {
                out.result(result);
                return;
            }

            for (const closed of result.closed) {
                out.println(`${flags.dryRun ? "would close" : "closed"} ${pc.bold(closed.id)}: ${closed.status}`);
            }

            for (const id of result.busy) {
                out.println(pc.yellow(`left ${id}: it is open in an approval window`));
            }

            if (result.closed.length === 0 && result.busy.length === 0) {
                out.println("Nothing to close.");
            }
        });
}

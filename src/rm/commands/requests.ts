import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    appendRmLedger,
    approvalDenyReason,
    createRmRequest,
    denyRmRequest,
    finishRmApproval,
    hardDenyReason,
    kickDrainer,
    listRmRequests,
    loadRmRequest,
    mayDenyRmRequest,
    type RmRequest,
    type RmRequestTarget,
    recheckAfterWait,
    recoverAsideJournals,
    rememberOptions,
    resolveTarget,
    saveRmRequest,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type ApproveEntry,
    approvalItems,
    approvalRequestInfo,
    approveDelete,
    approveRoots,
    denyRequest,
    splitBySelection,
} from "../lib/approve";
import { type PersonAnswer, printRequestHint, type RunContext, requirePerson, runContext, shown } from "../lib/run";

/** The decision lines under a request in `tools rm requests`. */
function printDecision(request: RmRequest): void {
    if (request.decided && request.decided.denied.length > 0) {
        out.println(
            pc.dim(`  decided: ${request.decided.approved.length} approved, ${request.decided.denied.length} put back`)
        );
    }

    if (request.batchId) {
        out.println(pc.dim(`  batch: ${request.batchId}`));
    }

    if (request.deniedNote) {
        out.println(`  denied: ${request.deniedNote}`);
    }
}

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
            approved: [...new Set([...(request.decided?.approved ?? []), ...approved.map((entry) => entry.wanted.path)])],
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

    out.println(pc.yellow(`Request ${id} stays pending for ${pending.length} blocked or changed path(s).`));
    process.exitCode = 1;
}

export function registerRequestCommands(program: Command): void {
    program
        .command("requests")
        .description("the requests agents made for the user to confirm")
        .option("--all", "also approved, denied and expired ones")
        .option("--json", "print as JSON")
        .action((flags: { all?: boolean; json?: boolean }) => {
            const requests = listRmRequests({ all: flags.all });

            if (flags.json) {
                out.result(requests);
                return;
            }

            if (requests.length === 0) {
                out.println(flags.all ? "No requests." : "No pending requests.");
                return;
            }

            for (const request of requests) {
                const who = request.caller
                    ? `${request.caller.agent} ${request.caller.sessionId?.slice(0, 8) ?? ""}`
                    : "?";
                out.println(
                    `${pc.bold(request.id)} ${request.kind} ${request.status} ${pc.dim(`${request.createdAt} ${who}`)}`
                );

                if (request.reason) {
                    out.println(`  why: ${request.reason}`);
                }

                for (const target of request.targets) {
                    out.println(`  ${target.path} ${pc.dim(`(${target.rule}: ${target.reason})`)}`);

                    if (target.stored) {
                        const size = target.bytes === undefined ? "" : `, ${formatBytes(target.bytes)}`;
                        out.println(pc.dim(`    waits aside at ${target.stored}${size}`));
                    }
                }

                printDecision(request);
            }
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
            const request = loadRmRequest(id);

            if (!request || request.status !== "pending") {
                out.println(pc.red(request ? `Request ${id} is ${request.status}.` : `No request ${id}.`));
                process.exitCode = 1;
                return;
            }

            // A path the person already denied whose aside copy could not go home waits for a deny, not a second
            // approval; a path that was blocked or changed while they decided can be approved again.
            const deniedBefore = new Set(request.decided?.denied ?? []);

            if (request.targets.some((target) => deniedBefore.has(target.path))) {
                out.println(
                    pc.red(`Request ${id} has unfinished recovery. Use tools rm deny ${id} to retry the put-back.`)
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
                process.exitCode = 1;
                return;
            }

            const items = await approvalItems(request, openEntries);
            const info = approvalRequestInfo(request, items);
            const who = info.asker ? (info.asker.session ?? info.asker.project ?? info.asker.agent) : "an agent";
            const verb =
                request.kind === "delete"
                    ? `Delete ${openEntries.length === 1 ? "1 item" : `${openEntries.length} items`}`
                    : `Trust ${shown(openEntries[0]?.target.path ?? "", ctx.cwd)}`;
            const answer = await requirePerson(ctx, {
                title: `${verb} for ${who}?`,
                lines: approvalLines(
                    request,
                    openEntries,
                    ctx,
                    items.map((item) => item.bytes)
                ),
                code: id,
                request: info,
                remember: rememberOptions(request.kind, request.caller),
            });

            if (!answer.approved) {
                if (answer.deniedByPerson) {
                    const back = denyRequest(request, {
                        caller: ctx.caller,
                        via: answer.via,
                        note: answer.choices.note,
                    });
                    out.println(back.kept.length ? `Request ${id} still needs recovery.` : `Request ${id} denied.`);
                    if (back.kept.length) {
                        process.exitCode = 1;
                    }
                }

                return;
            }

            const { approved, denied } = splitBySelection(openEntries, answer.choices.selected);

            if (approved.length === 0) {
                const back = denyRequest(request, { caller: ctx.caller, via: answer.via, note: answer.choices.note });
                out.println(
                    back.kept.length
                        ? `Request ${id} still needs recovery.`
                        : `Nothing was ticked: request ${id} denied.`
                );
                if (back.kept.length) {
                    process.exitCode = 1;
                }
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
            });
            const moved = ready.filter((entry) => !pending.includes(entry.wanted));
            // An unticked aside copy that could not go home stays pending, so its aside folder stays guarded.
            const notBack = (entry: ApproveEntry) => back.kept.some((kept) => kept.path === entry.wanted.path);
            pending.push(...denied.filter(notBack).map((entry) => entry.wanted));
            saveApproved({ request, answer, approved: moved, denied, pending, batchId: batch?.id, ctx });
            kickDrainer(ctx.config);
            exitPendingFor(id, pending);
        });

    program
        .command("deny")
        .description("close a request without doing it (an agent may cancel its own)")
        .argument("<id>", "the request id")
        .action((id: string) => {
            const ctx = runContext();
            recoverAsideJournals();
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

            const back = denyRequest(request, { caller: ctx.caller, via: "cli" });
            out.println(back.kept.length ? `Request ${id} still needs recovery.` : `Request ${id} closed.`);
            process.exitCode = back.kept.length > 0 ? 1 : 0;
        });
}

import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    appendRmLedger,
    createRmRequest,
    hardDenyReason,
    kickDrainer,
    listRmRequests,
    loadRmRequest,
    type RmRequest,
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

/** Records the decision on the request: approved (with the ticked and the put-back paths) and its batch. */
function saveApproved(input: {
    request: RmRequest;
    answer: PersonAnswer;
    approved: readonly ApproveEntry[];
    denied: readonly ApproveEntry[];
    batchId?: string;
    ctx: RunContext;
}): void {
    const { request, answer, approved, denied, batchId, ctx } = input;
    saveRmRequest({
        ...request,
        status: "approved",
        decidedAt: new Date().toISOString(),
        decidedVia: answer.via,
        decided: {
            approved: approved.map((entry) => entry.wanted.path),
            denied: denied.map((entry) => entry.wanted.path),
            disposal: request.kind === "delete" ? answer.choices.disposal : undefined,
            remember: request.kind === "delete" ? answer.choices.remember : undefined,
        },
        batchId,
    });
    appendRmLedger({ action: "approve", requestId: request.id, via: answer.via, caller: ctx.caller, batchId });
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
            const request = loadRmRequest(id);

            if (!request || request.status !== "pending") {
                out.println(pc.red(request ? `Request ${id} is ${request.status}.` : `No request ${id}.`));
                process.exitCode = 1;
                return;
            }

            // An aside item is approved where it waits (its stored copy); the original path is what gets recorded.
            const entries: ApproveEntry[] = request.targets.map((t) => ({
                wanted: t,
                target: resolveTarget(t.stored ?? t.path, request.cwd),
            }));
            const blocked = entries.filter((e) => hardDenyReason(e.target, ctx.rules) !== null);
            const openEntries = entries.filter((e) => !blocked.includes(e));

            for (const entry of blocked) {
                out.println(pc.red(`refuse ${entry.wanted.path}: ${hardDenyReason(entry.target, ctx.rules)}`));
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
                    denyRequest(request, { caller: ctx.caller, via: answer.via, note: answer.choices.note });
                    out.println(`Request ${id} denied.`);
                }

                return;
            }

            const { approved, denied } = splitBySelection(openEntries, answer.choices.selected);

            if (approved.length === 0) {
                denyRequest(request, { caller: ctx.caller, via: answer.via, note: answer.choices.note });
                out.println(`Nothing was ticked: request ${id} denied.`);
                return;
            }

            if (request.kind === "root") {
                approveRoots(ctx, request, approved, answer.via);
                saveApproved({ request, answer, approved, denied, ctx });
                return;
            }

            const { batch } = approveDelete({ ctx, request, approved, denied, choices: answer.choices });
            saveApproved({ request, answer, approved, denied, batchId: batch?.id, ctx });
            kickDrainer(ctx.config);
        });

    program
        .command("deny")
        .description("close a request without doing it (an agent may cancel its own)")
        .argument("<id>", "the request id")
        .action((id: string) => {
            const ctx = runContext();
            const request = loadRmRequest(id);

            if (!request || request.status !== "pending") {
                out.println(pc.red(request ? `Request ${id} is ${request.status}.` : `No request ${id}.`));
                process.exitCode = 1;
                return;
            }

            const back = denyRequest(request, { caller: ctx.caller, via: "cli" });
            out.println(`Request ${id} denied.`);
            process.exitCode = back.kept.length > 0 ? 1 : 0;
        });
}

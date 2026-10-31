import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    appendRmLedger,
    approvalDenyReason,
    approvalGraceMinutes,
    createRmRequest,
    denyRmRequest,
    finishRmApproval,
    hardDenyReason,
    kickDrainer,
    listRmRequests,
    loadRmRequest,
    mayDenyRmRequest,
    measureBytes,
    moveToTrash,
    type RmRequestTarget,
    recheckAfterWait,
    recoverAsideJournals,
    resolveTarget,
    saveRmConfig,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { printRequestHint, requirePerson, runContext, shown } from "../lib/run";

/** An aside batch folder that the decision emptied; a non-empty one (something kept) stays. */
function removeEmptyAsideDir(dir: string | undefined): void {
    if (!dir || !existsSync(dir) || readdirSync(dir).length > 0) {
        return;
    }

    rmdirSync(dir);
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

            // An aside item is approved where it waits (its stored copy); the original path is what gets recorded.
            const entries = request.targets.map((t) => ({
                wanted: t,
                target: resolveTarget(t.stored ?? t.path, request.cwd),
            }));
            // A root is trusted, not deleted: only the hard-deny rules apply to it, not the worktree ones.
            const denyOf = request.kind === "root" ? hardDenyReason : approvalDenyReason;
            const blocked = entries
                .map((e) => ({ ...e, denied: denyOf(e.target, ctx.rules) }))
                .filter((e) => e.denied !== null);
            const openEntries = entries.filter((e) => !blocked.some((b) => b.wanted === e.wanted));
            const open = openEntries.map((e) => e.target);

            for (const entry of blocked) {
                out.println(pc.red(`refuse ${entry.wanted.path}: ${entry.denied}`));
            }

            if (open.length === 0) {
                process.exitCode = 1;
                return;
            }

            const who = request.caller
                ? `${request.caller.agent} session ${request.caller.sessionId?.slice(0, 8) ?? "?"}`
                : "an agent";
            const lines = openEntries.map(({ wanted, target }) => {
                const bytes = wanted.bytes ?? measureBytes(target.path);
                const size = request.kind === "delete" ? `  ${formatBytes(bytes)}` : "";
                const where = wanted.stored ? ", moved aside" : "";
                return `${shown(wanted.path, ctx.cwd)}${size}  (${wanted.reason}${where})`;
            });

            if (request.reason) {
                lines.unshift(`Why: ${request.reason}`, "");
            }

            const verb =
                request.kind === "delete" ? `Delete ${open.length} path(s)` : `Trust ${open[0]?.path} as a root`;
            const answer = await requirePerson(ctx, { title: `${verb} for ${who}?`, lines, code: id });

            if (!answer.approved) {
                return;
            }

            // The prompt can wait for minutes: each path must still name what the person was shown, and still pass
            // the rules no approval overrides. A changed one stays in the request, which stays pending for it.
            const unresolved = new Set<RmRequestTarget>();
            const ready = openEntries.filter(({ wanted, target }) => {
                const reason = recheckAfterWait(target, ctx.rules, denyOf);

                if (reason) {
                    out.println(pc.red(`refuse ${wanted.path}: ${reason}`));
                    unresolved.add(wanted);
                }

                return reason === null;
            });

            if (ready.length === 0) {
                process.exitCode = 1;
                return;
            }

            if (request.kind === "root") {
                const roots = ready.map(({ target: t }) => ({
                    path: t.canonical,
                    note: request.reason ?? undefined,
                    addedAt: new Date().toISOString(),
                    via: `request:${id}`,
                }));
                saveRmConfig({ ...ctx.base, roots: [...ctx.base.roots, ...roots] });

                for (const root of roots) {
                    appendRmLedger({
                        action: "root-add",
                        path: root.path,
                        requestId: id,
                        via: answer.via,
                        caller: ctx.caller,
                    });
                }

                out.println(pc.green(`Trusted ${roots.map((r) => r.path).join(", ")}.`));
            } else {
                const byTarget = new Map(ready.map((e) => [e.target, e.wanted]));
                const batch = moveToTrash(
                    ready.map(({ wanted, target }) => ({
                        target,
                        rule: `approved ${id}`,
                        original: wanted.path,
                        bytes: wanted.bytes,
                    })),
                    {
                        config: ctx.config,
                        caller: request.caller,
                        graceMinutes: approvalGraceMinutes(request, ctx.base),
                        onRefused: (move, reason) => {
                            out.println(pc.red(`refuse ${move.original ?? move.target.path}: ${reason}`));
                            const wanted = byTarget.get(move.target);

                            if (wanted) {
                                unresolved.add(wanted);
                            }
                        },
                    }
                );
                removeEmptyAsideDir(request.asideDir);
                out.println(pc.green(`Moved ${batch?.items.length ?? 0} item(s) to the trash.`));

                if (batch) {
                    out.println(pc.dim(`  undo: ${toolCommand("rm")} restore ${batch.id}`));
                }

                kickDrainer(ctx.config);
            }

            const result = finishRmApproval({
                request,
                blocked: blocked.map((entry) => entry.wanted),
                unresolved,
                via: answer.via,
            });
            if (result.status === "pending") {
                out.println(
                    pc.yellow(`Request ${id} stays pending for ${result.targets.length} blocked or changed path(s).`)
                );
                process.exitCode = 1;
            }

            appendRmLedger({ action: "approve", requestId: id, via: answer.via, caller: ctx.caller });
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

            const back = denyRmRequest(request, ctx.caller);

            for (const path of back.returned) {
                out.println(pc.green(`put back ${path}`));
            }

            for (const kept of back.kept) {
                out.println(pc.yellow(`not put back ${kept.path}: ${kept.reason}`));
            }

            if (back.kept.length === 0) {
                removeEmptyAsideDir(request.asideDir);
            }

            if (back.waiting.length > 0) {
                out.println(
                    pc.yellow(`Request ${id} stays pending for ${back.waiting.length} path(s) that still wait aside.`)
                );
            } else {
                appendRmLedger({ action: "deny", requestId: id, caller: ctx.caller, path: resolve(request.cwd) });
                out.println(`Request ${id} denied.`);
            }

            process.exitCode = back.kept.length > 0 ? 1 : 0;
        });
}

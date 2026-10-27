import { resolve } from "node:path";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    appendRmLedger,
    createRmRequest,
    hardDenyReason,
    kickDrainer,
    listRmRequests,
    loadRmRequest,
    measureBytes,
    moveToTrash,
    resolveTarget,
    saveRmConfig,
    saveRmRequest,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { printRequestHint, requirePerson, runContext, shown } from "../lib/run";

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
        .description("confirm an agent's request (a person only: a typed code, or a macOS dialog)")
        .argument("<id>", "the request id")
        .action(async (id: string) => {
            const ctx = runContext();
            const request = loadRmRequest(id);

            if (!request || request.status !== "pending") {
                out.println(pc.red(request ? `Request ${id} is ${request.status}.` : `No request ${id}.`));
                process.exitCode = 1;
                return;
            }

            const targets = request.targets.map((t) => resolveTarget(t.path, request.cwd));
            const blocked = targets.filter((t) => hardDenyReason(t, ctx.rules) !== null);
            const open = targets.filter((t) => !blocked.includes(t));

            for (const target of blocked) {
                out.println(pc.red(`refuse ${target.path}: ${hardDenyReason(target, ctx.rules)}`));
            }

            if (open.length === 0) {
                process.exitCode = 1;
                return;
            }

            const who = request.caller
                ? `${request.caller.agent} session ${request.caller.sessionId?.slice(0, 8) ?? "?"}`
                : "an agent";
            const lines = open.map((t) => {
                const size = request.kind === "delete" ? `  ${formatBytes(measureBytes(t.path))}` : "";
                const why = request.targets.find((r) => r.path === t.path)?.reason ?? "";
                return `${shown(t.path, ctx.cwd)}${size}  (${why})`;
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

            if (request.kind === "root") {
                const roots = open.map((t) => ({
                    path: t.canonical,
                    note: request.reason ?? undefined,
                    addedAt: new Date().toISOString(),
                    via: `request:${id}`,
                }));
                saveRmConfig({ ...ctx.config, roots: [...ctx.config.roots, ...roots] });

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
                const batch = moveToTrash(
                    open.map((target) => ({ target, rule: `approved ${id}` })),
                    { config: ctx.config, caller: request.caller, graceMinutes: ctx.config.grace.otherMinutes }
                );
                out.println(pc.green(`Moved ${batch?.items.length ?? 0} item(s) to the trash.`));

                if (batch) {
                    out.println(pc.dim(`  undo: tools rm restore ${batch.id}`));
                }

                kickDrainer(ctx.config);
            }

            saveRmRequest({
                ...request,
                status: "approved",
                decidedAt: new Date().toISOString(),
                decidedVia: answer.via,
            });
            appendRmLedger({ action: "approve", requestId: id, via: answer.via, caller: ctx.caller });
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

            saveRmRequest({ ...request, status: "denied", decidedAt: new Date().toISOString(), decidedVia: "cli" });
            appendRmLedger({ action: "deny", requestId: id, caller: ctx.caller, path: resolve(request.cwd) });
            out.println(`Request ${id} denied.`);
        });
}

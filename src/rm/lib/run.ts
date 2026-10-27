import { relative } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { createStopwatch, formatBytes } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import {
    appendRmLedger,
    confirmByPerson,
    createRmRequest,
    defaultRuleContext,
    graceMinutesFor,
    isInside,
    kickDrainer,
    listBatches,
    loadRmConfig,
    measureBytes,
    moveToTrash,
    type RmCaller,
    type RmConfig,
    type RmPlanItem,
    type RmRuleContext,
    type RmVerdictKind,
    rmCallerFromRuntime,
    type TrashBatch,
} from "@genesiscz/utils/rm";
import pc from "picocolors";

export interface RunContext {
    config: RmConfig;
    caller: RmCaller;
    rules: RmRuleContext;
    cwd: string;
}

export function runContext(): RunContext {
    const config = loadRmConfig();
    const caller = rmCallerFromRuntime();
    const cwd = process.cwd();
    return { config, caller, cwd, rules: defaultRuleContext(config, caller, cwd) };
}

export function shown(path: string, cwd: string): string {
    return isInside(path, cwd) ? relative(cwd, path) : path;
}

const VERDICT_LABEL: Record<RmVerdictKind, string> = {
    allow: pc.green("delete"),
    ask: pc.yellow("ask   "),
    deny: pc.red("refuse"),
};

export interface ExecuteOptions {
    dryRun?: boolean;
    json?: boolean;
    reason?: string;
    keepMinutes?: number;
}

export interface ExecuteResult {
    batches: TrashBatch[];
    requestId: string | null;
    refused: number;
}

/**
 * Carries out a plan: refused paths are reported, paths that need a person become a request (or, for a person at a
 * terminal, a typed confirmation), and allowed paths move to the trash for the background drain.
 */
export async function executePlan(
    plan: RmPlanItem[],
    ctx: RunContext,
    options: ExecuteOptions
): Promise<ExecuteResult> {
    const result: ExecuteResult = { batches: [], requestId: null, refused: 0 };
    const sizes = new Map<string, number>();

    if (options.dryRun) {
        for (const item of plan) {
            if (item.verdict.kind !== "deny") {
                sizes.set(item.target.path, measureBytes(item.target.path));
            }
        }
    }

    if (!options.json) {
        for (const item of plan) {
            const size = sizes.has(item.target.path) ? pc.dim(` ${formatBytes(sizes.get(item.target.path) ?? 0)}`) : "";
            out.println(`${VERDICT_LABEL[item.verdict.kind]} ${shown(item.target.path, ctx.cwd)}${size}`);
            out.println(pc.dim(`         ${item.verdict.rule}: ${item.verdict.reason}`));
        }
    }

    if (options.dryRun) {
        if (options.json) {
            out.result(plan.map((item) => ({ ...summary(item), bytes: sizes.get(item.target.path) ?? null })));
            return result;
        }

        const waiting = listBatches();
        const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
        out.println(pc.dim(`Dry run: nothing moved. ${formatBytes(total)} would leave the disk.`));

        if (waiting.length > 0) {
            out.println(pc.dim(`The trash holds ${waiting.length} batch(es) the drain will delete (tools rm trash).`));
        }

        return result;
    }

    const refused = plan.filter((item) => item.verdict.kind === "deny");
    const asked = plan.filter((item) => item.verdict.kind === "ask");
    const allowed = plan.filter((item) => item.verdict.kind === "allow");

    for (const item of refused) {
        appendRmLedger({
            action: "refuse",
            path: item.target.path,
            rule: item.verdict.rule,
            reason: item.verdict.reason,
            caller: ctx.caller,
        });
    }

    result.refused = refused.length;

    if (asked.length > 0) {
        if (!ctx.caller.isInAgent && isInteractive()) {
            const outcome = await confirmByPerson({
                title: `Delete ${asked.length} path(s) that no rule allows?`,
                lines: asked.map((item) => `${item.target.path}  (${item.verdict.reason})`),
                code: "delete",
                caller: ctx.caller,
            });

            if (outcome.approved) {
                allowed.push(
                    ...asked.map((item) => ({
                        ...item,
                        verdict: { ...item.verdict, rule: `confirmed ${item.verdict.rule}` },
                    }))
                );
            } else {
                out.println(pc.yellow(`Kept ${asked.length} path(s): ${outcome.detail}.`));
            }
        } else {
            const request = createRmRequest({
                kind: "delete",
                caller: ctx.caller,
                cwd: ctx.cwd,
                reason: options.reason ?? null,
                targets: asked.map((item) => ({
                    path: item.target.path,
                    kind: item.target.kind,
                    rule: item.verdict.rule,
                    reason: item.verdict.reason,
                })),
            });
            result.requestId = request.id;

            if (!options.json) {
                printRequestHint(request.id, asked.length);
            }
        }
    }

    const groups = new Map<number, RmPlanItem[]>();

    for (const item of allowed) {
        const minutes = graceMinutesFor(item, ctx.rules, options.keepMinutes);
        groups.set(minutes, [...(groups.get(minutes) ?? []), item]);
    }

    for (const [minutes, items] of groups) {
        const elapsed = createStopwatch();
        const batch = moveToTrash(
            items.map((item) => ({ target: item.target, rule: item.verdict.rule })),
            { config: ctx.config, caller: ctx.caller, graceMinutes: minutes }
        );

        if (batch) {
            result.batches.push(batch);

            if (!options.json) {
                const when =
                    minutes === 0
                        ? "the drain deletes it now, in the background"
                        : `the drain deletes it in ${minutes} min`;
                out.println(pc.green(`Moved ${batch.items.length} item(s) to the trash in ${elapsed()}; ${when}.`));
                out.println(pc.dim(`  undo: tools rm restore ${batch.id}`));
            }
        }
    }

    kickDrainer(ctx.config);
    process.exitCode = refused.length > 0 ? 1 : result.requestId ? 3 : 0;

    if (options.json) {
        out.result({
            items: plan.map(summary),
            batches: result.batches.map((b) => ({ id: b.id, drainAfter: b.drainAfter, items: b.items.length })),
            request: result.requestId,
        });
    }

    logger.debug(
        { allowed: allowed.length, asked: asked.length, refused: refused.length, request: result.requestId },
        "rm: run finished"
    );
    return result;
}

function summary(item: RmPlanItem): Record<string, string | undefined> {
    return {
        path: item.target.path,
        kind: item.target.kind,
        verdict: item.verdict.kind,
        rule: item.verdict.rule,
        reason: item.verdict.reason,
        preset: item.verdict.presetId,
    };
}

export function printRequestHint(id: string, count: number): void {
    out.println(pc.yellow(`${count} path(s) need the user's confirmation (request ${id}).`));
    out.println(`Ask the user to run:  ${pc.bold(`tools rm approve ${id}`)}`);
    out.println(
        pc.dim(`  In Claude Code they can type: ! tools rm approve ${id}. It lists the paths and asks them to confirm.`)
    );
}

/** For a verb only a person may run (approve, roots add, config set): ask, and log how it was answered. */
export async function requirePerson(
    ctx: RunContext,
    prompt: { title: string; lines: string[]; code: string }
): Promise<{ approved: boolean; via: string }> {
    const outcome = await confirmByPerson({ ...prompt, caller: ctx.caller });

    if (!outcome.approved) {
        out.println(pc.red(`Not confirmed: ${outcome.detail}.`));
        process.exitCode = 1;
    }

    return { approved: outcome.approved, via: outcome.via };
}

export function minutesOption(value: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/.exec(value.trim());

    if (!match) {
        throw new Error(`Not a duration: ${value} (use minutes, or 30m, 2h, 1d)`);
    }

    const amount = Number(match[1]);
    const unit = match[2] ?? "m";
    return unit === "h" ? amount * 60 : unit === "d" ? amount * 1440 : amount;
}

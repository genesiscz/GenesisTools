import { relative } from "node:path";
import { isInteractive, toolCommand } from "@genesiscz/utils/cli";
import { createStopwatch, formatBytes } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type ApprovalPrompt,
    appendRmLedger,
    approvalItemReason,
    confirmByPerson,
    createAsideRequest,
    defaultRuleContext,
    effectiveConfig,
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
    recheckAfterWait,
    recoverAsideJournals,
    rmCallerFromRuntime,
    type TrashBatch,
} from "@genesiscz/utils/rm";
import pc from "picocolors";

export interface RunContext {
    /** The settings this caller runs under: the saved config with the matching profiles applied. */
    config: RmConfig;
    /** The saved config itself; a command that changes settings writes this, never `config`. */
    base: RmConfig;
    /** The profiles that matched this caller, in order. */
    profiles: string[];
    caller: RmCaller;
    rules: RmRuleContext;
    cwd: string;
}

export function runContext(): RunContext {
    const base = loadRmConfig();
    const caller = rmCallerFromRuntime();
    const cwd = process.cwd();
    const { config, applied } = effectiveConfig(base, caller, cwd);
    return { config, base, profiles: applied, caller, cwd, rules: defaultRuleContext(config, caller, cwd) };
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
    /** true: move what needs the user aside; false: leave it in place; undefined: the config's `askAction`. */
    aside?: boolean;
}

export interface ExecuteResult {
    batches: TrashBatch[];
    requestId: string | null;
    refused: number;
}

/**
 * Carries out a plan: refused paths are reported, paths that need a person become a request (or, for a person at a
 * terminal, a confirmation by person), and allowed paths move to the trash for the background drain.
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

        const waiting = listBatches().filter((batch) => !batch.incomplete);
        const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
        out.println(pc.dim(`Dry run: nothing moved. ${formatBytes(total)} would leave the disk.`));

        if (waiting.length > 0) {
            out.println(
                pc.dim(
                    `The trash holds ${waiting.length} batch(es) the drain will delete (${toolCommand("rm")} trash).`
                )
            );
        }

        return result;
    }

    // An aside run that died before it opened its request: its request opens now, so the user can decide it.
    recoverAsideJournals();
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
        if (!ctx.caller.isInAgent && isInteractive() && options.aside !== true) {
            const outcome = await confirmByPerson({
                title: `Delete ${asked.length === 1 ? "1 item" : `${asked.length} items`} that no rule allows?`,
                lines: asked.map((item) => `${item.target.path}  (${item.verdict.reason})`),
                code: "delete",
                caller: ctx.caller,
                approval: ctx.base.approval,
                request: {
                    id: null,
                    kind: "delete",
                    why: options.reason ?? null,
                    cwd: ctx.cwd,
                    graceMinutes: ctx.config.grace.otherMinutes,
                    items: asked.map((item) => ({
                        path: item.target.path,
                        kind: item.target.kind,
                        bytes: item.target.kind === "missing" ? undefined : measureBytes(item.target.path),
                        reason: approvalItemReason(item.verdict.rule, item.verdict.reason),
                    })),
                },
            });

            if (outcome.approved) {
                // The prompt can wait: a path that changed meanwhile, or now hits a rule no approval overrides, stays.
                for (const item of asked) {
                    const reason = recheckAfterWait(item.target, ctx.rules);

                    if (reason) {
                        out.println(pc.red(`refuse ${shown(item.target.path, ctx.cwd)}: ${reason}`));
                        appendRmLedger({
                            action: "refuse",
                            path: item.target.path,
                            rule: "target-changed",
                            reason,
                            caller: ctx.caller,
                        });
                        result.refused++;
                        continue;
                    }

                    allowed.push({ ...item, verdict: { ...item.verdict, rule: `confirmed ${item.verdict.rule}` } });
                }
            } else {
                out.println(pc.yellow(`Kept ${asked.length} path(s): ${outcome.detail}.`));
            }
        } else {
            result.requestId = requestForAsked(asked, ctx, options);
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
            {
                config: ctx.config,
                caller: ctx.caller,
                graceMinutes: minutes,
                onRefused: (move, reason) => {
                    out.println(pc.red(`refuse ${shown(move.target.path, ctx.cwd)}: ${reason}`));
                    result.refused++;
                },
            }
        );

        if (batch) {
            result.batches.push(batch);

            if (!options.json) {
                const when =
                    minutes === 0
                        ? "the drain deletes it now, in the background"
                        : `the drain deletes it in ${minutes} min`;
                out.println(pc.green(`Moved ${batch.items.length} item(s) to the trash in ${elapsed()}; ${when}.`));
                out.println(pc.dim(`  undo: ${toolCommand("rm")} restore ${batch.id}`));
            }
        }
    }

    kickDrainer(ctx.config);
    process.exitCode = result.refused > 0 ? 1 : result.requestId ? 3 : 0;

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

/**
 * Turns the paths that need the user into one request. With aside on, each path moves into the session's aside
 * folder first, out of the agent's way; unsaved work (unless `asideUnsaved`) and paths on another volume stay put.
 */
function requestForAsked(asked: RmPlanItem[], ctx: RunContext, options: ExecuteOptions): string {
    const asideOn = options.aside ?? ctx.config.askAction === "aside";
    const asideable = asideOn ? asked.filter((item) => ctx.config.asideUnsaved || !item.verdict.unsaved) : [];
    const inPlace = asked.filter((item) => !asideable.includes(item));
    const { request, aside } = createAsideRequest({
        aside: asideable,
        inPlace,
        caller: ctx.caller,
        cwd: ctx.cwd,
        reason: options.reason ?? null,
    });

    if (!options.json) {
        if (aside && aside.moved.length > 0) {
            const bytes = aside.moved.reduce((sum, t) => sum + (t.bytes ?? 0), 0);
            out.println(
                pc.yellow(`Moved ${aside.moved.length} path(s) aside (${formatBytes(bytes)}) to ${aside.dir}.`)
            );
            out.println(pc.dim("  They wait there for the user: approve deletes them, deny puts them back."));
        }

        for (const k of aside?.kept ?? []) {
            out.println(pc.dim(`  kept in place ${shown(k.input.target.path, ctx.cwd)}: ${k.reason}`));
        }

        for (const item of inPlace.filter((i) => asideOn && i.verdict.unsaved)) {
            out.println(
                pc.dim(`  kept in place ${shown(item.target.path, ctx.cwd)}: unsaved work, /tmp loses it on reboot`)
            );
        }

        printRequestHint(request.id, asked.length);
    }

    return request.id;
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
    out.println(`Ask the user to run:  ${pc.bold(`${toolCommand("rm")} approve ${id}`)}`);
    out.println(
        pc.dim(
            `  In Claude Code they can type: ! ${toolCommand("rm")} approve ${id}. It lists the paths and asks them to confirm.`
        )
    );
}

/** For a verb only a person may run (approve, roots add, config set): ask, and log how it was answered. */
export async function requirePerson(
    ctx: RunContext,
    prompt: Pick<ApprovalPrompt, "title" | "lines" | "code" | "request">
): Promise<{ approved: boolean; via: string }> {
    const outcome = await confirmByPerson({ ...prompt, caller: ctx.caller, approval: ctx.base.approval });

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

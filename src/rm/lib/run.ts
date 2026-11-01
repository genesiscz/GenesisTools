import { relative } from "node:path";
import { isInteractive, toolCommand } from "@genesiscz/utils/cli";
import { createStopwatch, formatBytes, formatCount } from "@genesiscz/utils/format";
import { rmEnablePresetCommand, rmRequestHintLine } from "@genesiscz/utils/genesis-tools/tools/hints";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type ApprovalChoices,
    type ApprovalPrompt,
    alreadyAskedInPlace,
    appendRmLedger,
    approvalItemReason,
    confirmByPerson,
    createAsideRequest,
    defaultRuleContext,
    disposalGraceMinutes,
    effectiveConfig,
    graceMinutesFor,
    isInside,
    kickDrainer,
    listRmRequests,
    loadRmConfig,
    measureBytes,
    moveToTrash,
    outcomeChoices,
    priorDenials,
    type RmCaller,
    type RmConfig,
    type RmPlanItem,
    type RmPriorDenial,
    type RmRequest,
    type RmRuleContext,
    type RmVerdictKind,
    recheckAfterWait,
    recoverAsideJournals,
    requestsAlsoNaming,
    rmCallerFromRuntime,
    startRmMeasurement,
    type TrashBatch,
} from "@genesiscz/utils/rm";
import pc from "picocolors";
import { liveSizes } from "./approve";
import { displayContext, middleCut, shortRmPath } from "./display";
import { notifyNewRequest } from "./notify";

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
    const rules = defaultRuleContext(config, caller, cwd, { enablePreset: rmEnablePresetCommand });
    return { config, base, profiles: applied, caller, cwd, rules };
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
    /** The person's earlier denials of these paths for this session, shown before the new request. */
    denials: RmPriorDenial[];
}

/** The background processes a run starts, and where its aside moves go; tests replace them. */
export interface ExecuteDeps {
    startMeasurement: (requestId: string) => void;
    kickDrainer: (config: RmConfig) => void;
    /** The aside root; the caller's session scratch when absent. */
    asideRoot?: string;
    /** Tells the person a new request waits (`notify.onRequest`); never fails the run. */
    notifyRequest: (request: RmRequest, ctx: RunContext) => Promise<void>;
}

const DEFAULT_EXECUTE_DEPS: ExecuteDeps = {
    startMeasurement: startRmMeasurement,
    kickDrainer,
    notifyRequest: notifyNewRequest,
};

/**
 * Carries out a plan: refused paths are reported, paths that need a person become a request (or, for a person at a
 * terminal, a confirmation by person), and allowed paths move to the trash for the background drain.
 */
export async function executePlan(
    plan: RmPlanItem[],
    ctx: RunContext,
    options: ExecuteOptions,
    deps: ExecuteDeps = DEFAULT_EXECUTE_DEPS
): Promise<ExecuteResult> {
    const result: ExecuteResult = { batches: [], requestId: null, refused: 0, denials: [] };
    const confirmedMinutes = new Map<RmPlanItem, number>();
    const sizes = new Map<string, number>();

    if (options.dryRun) {
        for (const item of plan) {
            if (item.verdict.kind !== "deny") {
                sizes.set(item.target.path, measureBytes(item.target.path));
            }
        }
    }

    if (options.dryRun) {
        printDryRun(plan, ctx, options, sizes);
        return result;
    }

    if (!options.json) {
        for (const item of plan) {
            out.println(`${VERDICT_LABEL[item.verdict.kind]} ${shown(item.target.path, ctx.cwd)}`);
            out.println(pc.dim(`         ${item.verdict.rule}: ${item.verdict.reason}`));
        }
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

    // Paths a person kept at the prompt; the run did not do what it was asked, so it does not exit 0.
    let declined = 0;
    // The request (and its aside move) waits until the allowed paths moved, since one may lie inside an asked folder.
    let requestLater = false;

    if (asked.length > 0) {
        if (!ctx.caller.isInAgent && isInteractive() && options.aside !== true) {
            const confirmed = await confirmAtTerminal(asked, ctx, options);

            // The prompt can wait: a path that changed meanwhile, or now hits a rule no approval overrides, stays.
            for (const [item, minutes] of confirmed) {
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

                allowed.push(item);
                confirmedMinutes.set(item, minutes);
            }

            declined = asked.length - confirmed.size;
        } else {
            requestLater = true;
        }
    }

    const groups = new Map<number, RmPlanItem[]>();

    for (const item of allowed) {
        const minutes = confirmedMinutes.get(item) ?? graceMinutesFor(item, ctx.rules, options.keepMinutes);
        groups.set(minutes, [...(groups.get(minutes) ?? []), item]);
    }

    // A move that throws (not a refusal: a disk or permission error) must not cost the asked paths their request,
    // and the batches that did move still need the drainer; the error is raised again after both.
    let moveError: unknown;

    try {
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
                    out.println(
                        pc.green(
                            `Moved ${formatCount(batch.items.length, "item")} to the trash in ${elapsed()}; ${when}.`
                        )
                    );
                    out.println(pc.dim(`  undo: ${toolCommand("rm")} restore ${batch.id}`));
                }
            }
        }
    } catch (error) {
        moveError = error;
    }

    if (requestLater) {
        const asking = requestForAsked(asked, ctx, options, deps);
        result.requestId = asking.id;
        result.denials = asking.denials;

        if (asking.created) {
            await deps.notifyRequest(asking.created, ctx);
        }
    }

    deps.kickDrainer(ctx.config);

    if (moveError !== undefined) {
        throw moveError;
    }

    process.exitCode = result.refused > 0 || declined > 0 ? 1 : result.requestId ? 3 : 0;

    if (options.json) {
        out.result({
            items: plan.map(summary),
            batches: result.batches.map((b) => ({ id: b.id, drainAfter: b.drainAfter, items: b.items.length })),
            request: result.requestId,
            deniedBefore: result.denials,
        });
    }

    logger.debug(
        { allowed: allowed.length, asked: asked.length, refused: refused.length, request: result.requestId },
        "rm: run finished"
    );
    return result;
}

/**
 * A person at a terminal confirms the paths no rule allows (Touch ID window, typed code or dialog). Returns the
 * confirmed items with their trash minutes: the window's ticked rows and disposal; the code and the dialog confirm
 * all of them to the trash (`--keep` / `--now` still set its time).
 */
async function confirmAtTerminal(
    asked: readonly RmPlanItem[],
    ctx: RunContext,
    options: ExecuteOptions
): Promise<Map<RmPlanItem, number>> {
    // The window opens at once; each size follows into it when its walk is done.
    const measuring = new AbortController();
    const present = asked.filter((item) => item.target.kind !== "missing");
    const updates = liveSizes(
        present.map((item) => item.target.path),
        { signal: measuring.signal }
    );
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
            graceMinutes: disposalGraceMinutes("trash", options.keepMinutes),
            askedAt: new Date().toISOString(),
            items: asked.map((item) => ({
                path: item.target.path,
                kind: item.target.kind,
                measuring: item.target.kind === "missing" ? undefined : true,
                reason: approvalItemReason(item.verdict.rule, item.verdict.reason),
            })),
        },
        updates,
    }).finally(() => measuring.abort());
    const confirmed = new Map<RmPlanItem, number>();

    if (!outcome.approved) {
        out.println(pc.yellow(`Kept ${formatCount(asked.length, "path")}: ${outcome.detail}.`));
        return confirmed;
    }

    const choices = outcomeChoices(outcome);
    const minutes = disposalGraceMinutes(choices.disposal, options.keepMinutes);
    const picked = pickedItems(asked, choices);

    for (const item of picked) {
        confirmed.set({ ...item, verdict: { ...item.verdict, rule: `confirmed ${item.verdict.rule}` } }, minutes);
    }

    if (picked.length < asked.length) {
        out.println(pc.yellow(`Kept ${formatCount(asked.length - picked.length, "path")} the person did not tick.`));
    }

    return confirmed;
}

function pickedItems(asked: readonly RmPlanItem[], choices: ApprovalChoices): RmPlanItem[] {
    const selected = choices.selected;

    if (!selected) {
        return [...asked];
    }

    return asked.filter((item) => selected.includes(item.target.path));
}

/** "The user denied this on <when>: <note>", for each path a person denied this session before. */
function printPriorDenials(denials: readonly RmPriorDenial[], cwd: string): void {
    for (const denial of denials) {
        const when = new Date(denial.decidedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        const note = denial.note ? `: ${denial.note}` : " (no note)";
        out.println(
            pc.yellow(`The user denied ${shown(denial.path, cwd)} on ${when} (request ${denial.requestId})${note}`)
        );
    }
}

/**
 * Turns the paths that need the user into one request. With aside on, each path moves into the session's aside
 * folder first, out of the agent's way; unsaved work (unless `asideUnsaved`) and paths on another volume stay put.
 */
function requestForAsked(
    asked: RmPlanItem[],
    ctx: RunContext,
    options: ExecuteOptions,
    deps: ExecuteDeps
): { id: string; denials: RmPriorDenial[]; created: RmRequest | null } {
    const denials = priorDenials(
        asked.map((item) => item.target.path),
        ctx.caller.sessionId,
        listRmRequests({ all: true })
    );

    if (!options.json) {
        printPriorDenials(denials, ctx.cwd);
    }

    const asideOn = options.aside ?? ctx.config.askAction === "aside";
    const asideable = asked.filter((item) => inPlaceReason(item, ctx, options) === null);
    const inPlace = asked.filter((item) => !asideable.includes(item));
    // An in-place path this session already asked about waits in that request; a second one would ask twice. An
    // aside path is never matched: its moved copy is a new object.
    const askedBefore = alreadyAskedInPlace(
        inPlace.map((item) => item.target.path),
        ctx.caller,
        listRmRequests()
    );
    const freshInPlace = inPlace.filter((item) => !askedBefore.has(item.target.path));

    if (!options.json) {
        for (const [path, id] of askedBefore) {
            out.println(pc.yellow(`already waits in request ${id}: ${shown(path, ctx.cwd)}`));
        }
    }

    if (asideable.length === 0 && freshInPlace.length === 0) {
        const first = [...askedBefore.values()][0] ?? "";

        if (!options.json) {
            printRequestHint(first, inPlace.length);
        }

        return { id: first, denials, created: null };
    }

    const { request, aside } = createAsideRequest({
        aside: asideable,
        inPlace: freshInPlace,
        caller: ctx.caller,
        cwd: ctx.cwd,
        reason: options.reason ?? null,
        root: deps.asideRoot,
    });

    // The sizes are measured in the background, so `approve` opens its window without walking the trees.
    deps.startMeasurement(request.id);

    if (!options.json) {
        if (aside && aside.moved.length > 0) {
            out.println(pc.yellow(`Moved ${formatCount(aside.moved.length, "path")} aside to ${aside.dir}.`));
            out.println(pc.dim("  They wait there for the user: approve deletes them, deny puts them back."));
        }

        for (const k of aside?.kept ?? []) {
            out.println(pc.dim(`  kept in place ${shown(k.input.target.path, ctx.cwd)}: ${k.reason}`));
        }

        for (const item of freshInPlace.filter((i) => asideOn && i.verdict.stayInPlace)) {
            out.println(pc.dim(`  kept in place ${shown(item.target.path, ctx.cwd)}: ${item.verdict.stayInPlace}`));
        }

        for (const item of freshInPlace.filter((i) => asideOn && i.verdict.unsaved && !i.verdict.stayInPlace)) {
            out.println(
                pc.dim(`  kept in place ${shown(item.target.path, ctx.cwd)}: unsaved work, /tmp loses it on reboot`)
            );
        }

        printRequestHint(request.id, request.targets.length);
    }

    return { id: request.id, denials, created: request };
}

/**
 * Why an asked path waits where it is instead of moving into the aside folder, or null when it moves aside. A move
 * to another volume is found only when it is tried, so a dry run cannot name that case.
 */
function inPlaceReason(item: RmPlanItem, ctx: RunContext, options: ExecuteOptions): string | null {
    if (!(options.aside ?? ctx.config.askAction === "aside")) {
        return "aside is off";
    }

    // A live cache (`stayInPlace`) never moves: another install may read it while it waits.
    if (item.verdict.stayInPlace) {
        return item.verdict.stayInPlace;
    }

    if (item.verdict.unsaved && !ctx.config.asideUnsaved) {
        return "unsaved work, /tmp loses it on reboot";
    }

    return null;
}

const DRY_LABEL: Record<RmVerdictKind, { text: string; color: (text: string) => string }> = {
    allow: { text: "delete", color: pc.green },
    ask: { text: "ask", color: pc.yellow },
    deny: { text: "refuse", color: pc.red },
};
const DRY_PATH_MAX = 48;

/**
 * A dry run: one row per path (`VERDICT SIZE PATH RULE`, where an ask row says whether it moves aside and which open
 * requests already name it), each rule's reason once under the table, and a summary split by what would happen.
 */
function printDryRun(plan: RmPlanItem[], ctx: RunContext, options: ExecuteOptions, sizes: Map<string, number>): void {
    const alsoIn = requestsAlsoNaming(
        plan.map((item) => item.target.path),
        "",
        listRmRequests()
    );

    if (options.json) {
        out.result(
            plan.map((item) => ({
                ...summary(item),
                bytes: sizes.get(item.target.path) ?? null,
                willAside: item.verdict.kind === "ask" && inPlaceReason(item, ctx, options) === null,
                alsoIn: alsoIn.get(item.target.path) ?? [],
            }))
        );
        return;
    }

    const display = displayContext(ctx.caller);
    const rows = plan.map((item) => {
        const path = item.target.path;
        const notes = [item.verdict.rule];

        if (item.verdict.kind === "ask") {
            const why = inPlaceReason(item, ctx, options);
            notes.push(why ? `stays in place (${why})` : "moves aside");
            const ids = alsoIn.get(path) ?? [];

            if (ids.length > 0) {
                notes.push(`already asked in ${ids.join(" ")}`);
            }
        }

        return {
            item,
            size: sizes.has(path) ? formatBytes(sizes.get(path) ?? 0) : "-",
            path: isInside(path, ctx.cwd)
                ? middleCut(relative(ctx.cwd, path), DRY_PATH_MAX)
                : shortRmPath(path, display, DRY_PATH_MAX),
            notes: notes.join(" · "),
        };
    });
    const sizeWidth = Math.max(4, ...rows.map((row) => row.size.length));
    const pathWidth = Math.max(4, ...rows.map((row) => row.path.length));

    out.println(pc.dim(`${"VERDICT".padEnd(7)}  ${"SIZE".padStart(sizeWidth)}  ${"PATH".padEnd(pathWidth)}  RULE`));

    for (const row of rows) {
        const label = DRY_LABEL[row.item.verdict.kind];
        out.println(
            `${label.color(label.text.padEnd(7))}  ${row.size.padStart(sizeWidth)}  ${row.path.padEnd(pathWidth)}  ${pc.dim(row.notes)}`
        );
    }

    out.println("");

    for (const reason of new Set(plan.map((item) => `${item.verdict.rule}: ${item.verdict.reason}`))) {
        out.println(pc.dim(`  ${reason}`));
    }

    const bytesOf = (kind: RmVerdictKind) =>
        plan
            .filter((item) => item.verdict.kind === kind)
            .reduce((sum, item) => sum + (sizes.get(item.target.path) ?? 0), 0);
    const asks = plan.filter((item) => item.verdict.kind === "ask").length;
    const refused = plan.filter((item) => item.verdict.kind === "deny").length;
    const parts = [`${formatBytes(bytesOf("allow"))} would go now`];

    if (asks > 0) {
        parts.push(`${formatBytes(bytesOf("ask"))} needs the user (1 request)`);
    }

    if (refused > 0) {
        parts.push(`${refused} refused`);
    }

    out.println(`Dry run: ${parts.join(" · ")}. Nothing moved.`);
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
    const rm = toolCommand("rm");
    out.println(
        pc.yellow(
            `${formatCount(count, "path")} ${count === 1 ? "needs" : "need"} the user's confirmation (request ${id}).`
        )
    );
    out.println(
        pc.dim(`  In Claude Code the user types: ! ${rm} approve ${id}. It lists the paths and asks them to confirm.`)
    );
    // The last line stands alone: agents often keep only `| tail -1` of this output.
    out.println(rmRequestHintLine(id, count));
}

/** For a verb only a person may run (approve, roots add, config set): ask, and log how it was answered. */
export async function requirePerson(
    ctx: RunContext,
    prompt: Pick<ApprovalPrompt, "title" | "lines" | "code" | "request" | "remember" | "updates">
): Promise<PersonAnswer> {
    const outcome = await confirmByPerson({ ...prompt, caller: ctx.caller, approval: ctx.base.approval });

    if (!outcome.approved) {
        out.println(pc.red(`Not confirmed: ${outcome.detail}.`));
        process.exitCode = 1;
    }

    return {
        approved: outcome.approved,
        via: outcome.via,
        choices: outcomeChoices(outcome),
        deniedByPerson: outcome.deniedByPerson === true,
    };
}

export interface PersonAnswer {
    approved: boolean;
    via: string;
    /** The window's picks; the typed code and the dialog answer all items, trash, once. */
    choices: ApprovalChoices;
    /** The person pressed Deny in the window (a timeout or a failed touch is not). */
    deniedByPerson: boolean;
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

/** A size in megabytes for a setting: a number of 0 or more (`10`, `2.5`). */
export function megabytesOption(value: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*(?:MB)?$/i.exec(value.trim());

    if (!match) {
        throw new Error(`Not a size in megabytes: ${value} (use a number such as 10, or 0 for off)`);
    }

    return Number(match[1]);
}

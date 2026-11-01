import { isInteractive, toolCommand } from "@genesiscz/utils/cli";
import { formatBytes, formatCount } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import {
    ApprovalUpdates,
    appendRmLedger,
    approvalAsker,
    approvalDenyReason,
    createRmRequest,
    hardDenyReason,
    listRmRequests,
    loadRmMeasurementOf,
    loadRmRequest,
    lockRmRequest,
    mayDenyRmRequest,
    measureRmRequest,
    pruneReason,
    pruneRmRequests,
    RM_APPROVED_TRASH_MINUTES,
    type RmRequest,
    type RmRequestTarget,
    recoverAsideJournals,
    rememberOptions,
    requestLive,
    reserveRmRequestId,
    resolveTarget,
    updateRmRequest,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import {
    type ApprovalDenyCheck,
    type ApproveEntry,
    applyApprovalAnswer,
    approvalRequestInfo,
    approvalRows,
    CAME_BACK_REASON,
    cameBack,
    closeAllLost,
    copyLost,
    denyRequest,
    printDenyOutcome,
    reportLostCopies,
} from "../lib/approve";
import { buildRequestViews, renderRequestDetail, renderRequestList, renderRequestRow } from "../lib/requests-view";
import { minutesOption, printRequestHint, type RunContext, requirePerson, runContext, shown } from "../lib/run";

function approvalLines(
    request: RmRequest,
    entries: readonly ApproveEntry[],
    ctx: RunContext,
    sizes: (number | undefined)[]
) {
    const lines = entries.map(({ wanted }, index) => {
        const bytes = sizes[index];
        const size = bytes === undefined ? "" : `  ${formatBytes(bytes)}`;

        if (cameBack(wanted)) {
            return `${shown(wanted.path, ctx.cwd)}${size}  (${CAME_BACK_REASON}: ${wanted.stored})`;
        }

        const where = wanted.stored ? ", moved aside" : "";
        return `${shown(wanted.path, ctx.cwd)}${size}  (${wanted.reason}${where})`;
    });

    if (request.reason) {
        lines.unshift(`Why: ${request.reason}`, "");
    }

    return lines;
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

/** A request's rows for the approval window, and the paths the rules refuse before any prompt. */
interface PreparedApproval {
    /** Paths the rules refuse now: they keep the request pending and the window does not show them. */
    blocked: ApproveEntry[];
    openEntries: ApproveEntry[];
    /** Paths whose aside copy is gone (deleted outside tools rm): neither shown nor blocking, and decided no further. */
    lost: RmRequestTarget[];
    denyOf: ApprovalDenyCheck;
}

/**
 * The rows `request` offers a person, the paths refused before the prompt, and the lost aside copies (each printed
 * and logged unless `quiet`).
 */
function prepareApproval(request: RmRequest, ctx: RunContext, quiet = false): PreparedApproval {
    const lost = request.targets.filter(copyLost);

    if (!quiet) {
        reportLostCopies(request, lost, ctx.caller);
    }

    // An aside item is approved where it waits (its stored copy); the original path is what gets recorded.
    const entries: ApproveEntry[] = request.targets
        .filter((t) => !lost.includes(t))
        .map((t) => ({
            wanted: t,
            target: resolveTarget(t.stored ?? t.path, request.cwd),
        }));
    // A root is trusted, not deleted: only the hard-deny rules apply to it, not the worktree ones.
    const denyOf: ApprovalDenyCheck = request.kind === "root" ? hardDenyReason : approvalDenyReason;
    const refused = entries
        .map((entry) => ({ entry, denied: denyOf(entry.target, ctx.rules) }))
        .filter((refusal) => refusal.denied !== null);

    if (!quiet) {
        for (const { entry, denied } of refused) {
            out.println(pc.red(`refuse ${entry.wanted.path}: ${denied}`));
        }
    }

    const blocked = refused.map((refusal) => refusal.entry);
    return { blocked, openEntries: entries.filter((entry) => !blocked.includes(entry)), lost, denyOf };
}

/** Why a batch approval leaves `request` out, or null: it takes only open delete requests a window can decide. */
function leftOutReason(request: RmRequest | null, id: string): string | null {
    const rm = toolCommand("rm");

    if (!request) {
        return "no such request";
    }

    if (request.status !== "pending") {
        return `it is ${request.status}`;
    }

    if (request.kind === "root") {
        return `a root request is approved on its own: ${rm} approve ${id}`;
    }

    if (requestLive(request).state === "gone") {
        return `nothing is left to decide: ${rm} prune`;
    }

    const deniedBefore = new Set(request.decided?.denied ?? []);

    if (request.targets.some((target) => deniedBefore.has(target.path) && !cameBack(target))) {
        return `it has unfinished recovery: ${rm} deny ${id}`;
    }

    return null;
}

/** One stream of row updates for a window that shows the rows of several requests. */
function mergeUpdates(sources: readonly ApprovalUpdates[]): ApprovalUpdates {
    const merged = new ApprovalUpdates();
    Promise.all(
        sources.map(async (source) => {
            for await (const update of source.read()) {
                merged.push(update);
            }
        })
    )
        .catch((error: unknown) => logger.warn({ error }, "rm: merging the batch window's row updates failed"))
        .finally(() => merged.close());
    return merged;
}

/** A request of a batch approval, the rows the window shows for it, and its in-place rows an earlier part shows. */
interface BatchPart {
    request: RmRequest;
    rows: ApproveEntry[];
    /** Decided by the earlier part's row: approved through the shared-path settle, denied or unticked here. */
    shared: ApproveEntry[];
}

/** The person check and the background drain of a batch approval; tests replace them. */
export interface BatchDeps {
    ask: typeof requirePerson;
    kickDrainer: (config: RunContext["config"]) => void;
}

/** The same path as a row key: an aside copy and an in-place path of one name are different objects. */
function rowKey(target: RmRequestTarget): string {
    return `${target.path}\u0000${target.stored ?? ""}`;
}

/**
 * `tools rm approve <id> <id> ...`: one window and one person check for the rows of several requests. The set is
 * fixed when every lock is held, so a request made while the window is open never rides along. An in-place path
 * that two requests name is one row: the first request owns it, an approval reaches the other through the shared-path
 * settle, and a Deny or an unticked row denies the path in every request that names it.
 */
export async function approveMany(
    ids: readonly string[],
    ctx: RunContext,
    deps: Partial<BatchDeps> = {}
): Promise<void> {
    const ask = deps.ask ?? requirePerson;
    const releases: Array<() => void> = [];

    try {
        const parts: BatchPart[] = [];
        const inPlaceOwner = new Map<string, string>();
        const asidePaths = new Set<string>();
        // Requests with nothing left but lost aside copies: closed as gone here, never a failure.
        let closedLost = 0;

        for (const id of [...new Set(ids)].sort()) {
            const lock = lockRmRequest(id);

            if (!lock.ok) {
                const holder = lock.holder ? ` (pid ${lock.holder})` : "";
                out.println(pc.yellow(`left out ${id}: it is open in an approval window${holder}`));
                continue;
            }

            releases.push(lock.release);
            const request = loadRmRequest(id);
            const why = leftOutReason(request, id);

            if (why || !request) {
                out.println(pc.yellow(`left out ${id}: ${why ?? "no such request"}`));
                continue;
            }

            const { openEntries, blocked } = prepareApproval(request, ctx);

            if (openEntries.length === 0 && blocked.length === 0) {
                closeAllLost(request, ctx.caller);
                closedLost++;
                continue;
            }

            // The window answers with paths, so two rows of one path cannot be told apart in it. Only two in-place
            // rows of one path name the same object (one shared row); an aside or came-back copy beside any other
            // row of its path is a different object, so its request is left out.
            const samePath = openEntries.some(({ wanted }) =>
                wanted.stored
                    ? asidePaths.has(wanted.path) || inPlaceOwner.has(wanted.path)
                    : asidePaths.has(wanted.path)
            );

            if (samePath) {
                out.println(pc.yellow(`left out ${id}: another request here names the same path`));
                continue;
            }

            const rows = openEntries.filter((entry) => entry.wanted.stored || !inPlaceOwner.has(entry.wanted.path));
            const shared = openEntries.filter((entry) => !rows.includes(entry));

            for (const { wanted } of rows) {
                if (wanted.stored) {
                    asidePaths.add(wanted.path);
                } else {
                    inPlaceOwner.set(wanted.path, id);
                }
            }

            parts.push({ request, rows, shared });
        }

        const shown = parts.filter((part) => part.rows.length > 0);

        if (shown.length === 0 && closedLost > 0) {
            return;
        }

        if (shown.length === 0) {
            out.println(pc.red("Nothing to approve."));
            process.exitCode = 1;
            return;
        }

        const measuring = new AbortController();
        const perPart = shown.map((part) => approvalRows(part.request, part.rows, { signal: measuring.signal }));
        const items = perPart.flatMap((rows) => rows.items);
        const sessions = new Set(shown.map((part) => part.request.caller?.sessionId ?? null));
        const askedAt = shown.map((part) => part.request.createdAt).sort()[0];
        const lines = shown.flatMap((part, index) => {
            const caller = part.request.caller;
            const who = caller?.sessionTitle ?? caller?.project ?? caller?.agent ?? "a person";
            const sizes = (perPart[index]?.items ?? []).map((item) => item.bytes);
            return [
                `${part.request.id} · ${who} · ${formatCount(part.rows.length, "item")}`,
                ...approvalLines(part.request, part.rows, ctx, sizes).map((line) => `  ${line}`),
            ];
        });
        out.println(
            pc.dim(
                `Opening the approval window for ${formatCount(items.length, "item")} from ${shown.length} requests…`
            )
        );
        const answer = await ask(ctx, {
            title: `Delete ${items.length} items from ${shown.length} requests?`,
            lines,
            code: reserveRmRequestId(),
            request: {
                id: null,
                kind: "delete",
                why: null,
                cwd: ctx.cwd,
                graceMinutes: RM_APPROVED_TRASH_MINUTES,
                askedAt,
                asker: sessions.size === 1 ? approvalAsker(shown[0]?.request.caller) : undefined,
                items,
            },
            updates: mergeUpdates(perPart.map((rows) => rows.updates)),
        }).finally(() => measuring.abort());

        // Every part, also one whose rows are all shared: a Deny or an unticked shared row must reach it too.
        for (const part of parts) {
            // An earlier request's approval may have decided a path of this one (the shared-path settle): read it
            // again, and decide only the rows the window showed for it, its own or the earlier part's.
            const fresh = loadRmRequest(part.request.id);

            if (fresh?.status !== "pending") {
                continue;
            }

            const again = prepareApproval(fresh, ctx, true);
            // Each row keeps the identity pinned BEFORE the window opened: the checks after the wait (and the
            // verified rename) compare against what the person was shown, so a path swapped meanwhile is refused.
            const pinned = new Map([...part.rows, ...part.shared].map((entry) => [rowKey(entry.wanted), entry.target]));
            const openEntries = again.openEntries.flatMap((entry) => {
                const target = pinned.get(rowKey(entry.wanted));
                return target ? [{ wanted: entry.wanted, target }] : [];
            });
            const notShown = again.openEntries.filter((entry) => !pinned.has(rowKey(entry.wanted)));
            const paths = new Set(openEntries.map((entry) => entry.wanted.path));
            const selected = answer.choices.selected?.filter((path) => paths.has(path)) ?? null;

            if (openEntries.length === 0) {
                continue;
            }

            applyApprovalAnswer({
                ctx,
                request: fresh,
                openEntries,
                blocked: [...again.blocked, ...notShown],
                answer,
                selected,
                denyOf: again.denyOf,
                kickDrainer: deps.kickDrainer,
            });
        }
    } finally {
        for (const release of releases) {
            release();
        }
    }
}

/** The requests of this very session, which it may deny without a person (`mayDenyRmRequest` for an agent). */
function ownSession(request: RmRequest, caller: RunContext["caller"]): boolean {
    return (
        caller.sessionId !== null &&
        request.caller?.agent === caller.agent &&
        request.caller?.sessionId === caller.sessionId
    );
}

/**
 * The picker's deny: the caller's own requests go at once, the other sessions' after ONE person check, and each deny
 * records how the person answered (`touch-id`, `dialog`), so the asking agent reads it as the person's answer.
 */
export async function denyPicked(
    ids: readonly string[],
    ctx: RunContext,
    deps: { ask?: typeof requirePerson; note?: () => Promise<string> } = {}
): Promise<void> {
    const ask = deps.ask ?? requirePerson;
    const note = deps.note ?? (() => p.text({ message: "A note for the asking agent (optional, Enter for none)" }));
    const releases: Array<() => void> = [];

    try {
        const requests: RmRequest[] = [];

        for (const id of [...new Set(ids)].sort()) {
            const lock = lockRmRequest(id);

            if (!lock.ok) {
                out.println(pc.yellow(`left out ${id}: it is open in an approval window`));
                continue;
            }

            releases.push(lock.release);
            const request = loadRmRequest(id);

            if (request?.status !== "pending") {
                out.println(pc.yellow(`left out ${id}: ${request ? `it is ${request.status}` : "no such request"}`));
                continue;
            }

            requests.push(request);
        }

        const own = requests.filter((request) => ownSession(request, ctx.caller));
        const others = requests.filter((request) => !own.includes(request));

        for (const request of own) {
            const outcome = denyRequest(request, { caller: ctx.caller, via: "cli" });
            printDenyOutcome(request.id, outcome, `Request ${request.id} denied.`);
        }

        if (others.length === 0) {
            return;
        }

        let typed: string;

        try {
            typed = (await note()).trim();
        } catch (error) {
            logger.debug({ error }, "rm: the deny note was cancelled");
            out.println("Nothing done.");
            return;
        }

        const answer = await ask(ctx, {
            title: `Deny ${formatCount(others.length, "request")} from other sessions?`,
            lines: others.flatMap((request) => [
                `${request.id} · ${request.caller?.sessionTitle ?? request.caller?.agent ?? "a person"}`,
                ...request.targets.map((target) => `  ${target.path}`),
            ]),
            code: reserveRmRequestId(),
        });

        if (!answer.approved) {
            return;
        }

        for (const request of others) {
            const outcome = denyRequest(request, { caller: ctx.caller, via: answer.via, note: typed || null });
            printDenyOutcome(request.id, outcome, `Request ${request.id} denied.`);
        }
    } finally {
        for (const release of releases) {
            release();
        }
    }
}

/** The picker's close: the ticked requests nothing is left of become `gone`, as prune closes them; nothing moves. */
function closePicked(ids: readonly string[], ctx: RunContext): void {
    const now = new Date();

    for (const id of ids) {
        const update = updateRmRequest(id, (fresh) =>
            pruneReason(fresh, now) === "gone"
                ? { ...fresh, status: "gone", decidedAt: now.toISOString(), decidedVia: "person" }
                : null
        );

        if (update.kind === "saved") {
            appendRmLedger({ action: "close", requestId: id, reason: "gone", caller: ctx.caller });
            out.println(`closed ${pc.bold(id)}: gone`);
        } else {
            out.println(
                pc.yellow(
                    `left ${id}: ${update.kind === "busy" ? "open in an approval window" : "something is still there to decide"}`
                )
            );
        }
    }
}

type PickerAction = "approve" | "deny" | "close" | "cancel";

const PICKER_ACTIONS: Record<
    PickerAction,
    { label: string; run: (ids: string[], ctx: RunContext) => Promise<void> | void }
> = {
    approve: { label: "Approve the ticked ones (one window)", run: (ids, ctx) => approveMany(ids, ctx) },
    deny: { label: "Deny the ticked ones", run: denyPicked },
    close: { label: "Close the ticked gone ones (nothing moves)", run: closePicked },
    cancel: { label: "Cancel", run: () => out.println("Nothing done.") },
};

function isPickerAction(value: unknown): value is PickerAction {
    return typeof value === "string" && value in PICKER_ACTIONS;
}

/** `tools rm approve` with no id, for a person at a terminal: tick requests, then pick what happens to them. */
async function pickAndDecide(ctx: RunContext): Promise<void> {
    const requests = listRmRequests();

    if (requests.length === 0) {
        out.println("No pending requests.");
        return;
    }

    const now = new Date();
    const views = buildRequestViews(requests, { sizeOf: listedSize }).sort(
        (a, b) =>
            (a.request.caller?.sessionId ?? "").localeCompare(b.request.caller?.sessionId ?? "") ||
            a.request.createdAt.localeCompare(b.request.createdAt)
    );
    let ticked: string[];
    let action: unknown;

    try {
        ticked = (
            await p.multiselect({
                message: "Which requests?",
                options: views.map((view) => ({
                    value: view.request.id,
                    label: renderRequestRow(view, now),
                    hint: `${(view.request.caller?.sessionId ?? "person").slice(0, 8)} ${view.request.caller?.sessionTitle ?? ""}`.trim(),
                })),
                required: false,
            })
        ).map(String);

        if (ticked.length === 0) {
            out.println("Nothing ticked.");
            return;
        }

        action = await p.select({
            message: `What happens to the ${formatCount(ticked.length, "ticked request")}?`,
            options: Object.entries(PICKER_ACTIONS).map(([value, { label }]) => ({ value, label })),
        });
    } catch (error) {
        logger.debug({ error }, "rm: the request picker was cancelled");
        out.println("Nothing done.");
        return;
    }

    if (isPickerAction(action)) {
        await PICKER_ACTIONS[action].run(ticked, ctx);
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
    // approval; a path that was blocked or changed while they decided can be approved again. A path that came back
    // beside its copy can never go home, so approving (which deletes only the copy) is the one way forward.
    const deniedBefore = new Set(request.decided?.denied ?? []);

    if (request.targets.some((target) => deniedBefore.has(target.path) && !cameBack(target))) {
        out.println(
            pc.red(`Request ${id} has unfinished recovery. Use ${toolCommand("rm")} deny ${id} to retry the put-back.`)
        );
        process.exitCode = 1;
        return;
    }

    const prepared = prepareApproval(request, ctx);
    const { openEntries } = prepared;

    if (openEntries.length === 0 && prepared.blocked.length === 0) {
        closeAllLost(request, ctx.caller);
        return;
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
    out.println(pc.dim(`Opening the approval window for ${id} (${formatCount(openEntries.length, "item")})…`));
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
    applyApprovalAnswer({
        ctx,
        request,
        openEntries,
        blocked: prepared.blocked,
        answer,
        selected: answer.choices.selected,
        denyOf: prepared.denyOf,
    });
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
        .argument("[ids...]", "request ids: one window for all of them; none: a picker on a terminal")
        .option("--session <id>", "also every pending request of this session (an id or its prefix)")
        .option("--older <duration>", "also every pending request older than 30m, 2h, 1d, ...", minutesOption)
        .action(async (ids: string[], flags: { session?: string; older?: number }) => {
            const ctx = runContext();
            recoverAsideJournals();
            const filtered = flags.session !== undefined || flags.older !== undefined;
            const matched = filtered ? pickRequests({ session: flags.session, older: flags.older }, new Date()) : [];
            const chosen = [...new Set([...ids, ...matched.map((request) => request.id)])];
            const [only] = chosen;

            if (chosen.length === 1 && only) {
                await underDecisionLock(
                    only,
                    (holder) =>
                        `Request ${only} is open in an approval window${holder ? ` (pid ${holder})` : ""}. Answer that window.`,
                    () => approveOne(only, ctx)
                );
                return;
            }

            if (chosen.length > 1) {
                await approveMany(chosen, ctx);
                return;
            }

            if (filtered) {
                out.println("No pending request matches.");
                process.exitCode = 1;
                return;
            }

            if (isInteractive() && !ctx.caller.isInAgent) {
                await pickAndDecide(ctx);
                return;
            }

            out.println(`Name the request ids, or run ${toolCommand("rm")} approve in a terminal for the picker.`);
            process.exitCode = 1;
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
                    : `Measured ${formatCount(result.measured, "path")} of request ${id}; ${result.fresh} ${result.fresh === 1 ? "was" : "were"} still fresh.`
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

            // A dry run never writes: the recovery saves requests and removes aside journals.
            if (!flags.dryRun) {
                recoverAsideJournals();
            }

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

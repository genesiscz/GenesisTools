import { applyRestorePlan } from "@app/claude/lib/cmux/apply";
import { buildLaunchCommand } from "@app/claude/lib/cmux/command";
import { candidateHint, candidateLabel, labelWidths, placeOf } from "@app/claude/lib/cmux/display";
import { positiveIntFlag } from "@app/claude/lib/cmux/flags";
import { buildRestorePlan } from "@app/claude/lib/cmux/plan";
import { listCandidates } from "@app/claude/lib/cmux/sessions";
import { type RestoreSettings, type TuneAction, tuneOptions } from "@app/claude/lib/cmux/settings";
import { loadSnapshot, snapshotCandidates } from "@app/claude/lib/cmux/snapshot";
import type { LayoutMode, RestoreCandidate, RestorePlan } from "@app/claude/lib/cmux/types";
import * as p from "@clack/prompts";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { resolveProjectFilter } from "@genesiscz/utils/claude";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { cancelSymbol, searchMultiselect } from "@genesiscz/utils/prompts/clack/search-multiselect";
import pc from "picocolors";

export interface RestoreOptions {
    last: string;
    thisProject?: boolean;
    allProjects?: boolean;
    layout: LayoutMode;
    perWorkspace: string;
    perProject: boolean;
    enter: boolean;
    account?: string;
    autopick?: boolean;
    newWindow?: boolean;
    dryRun?: boolean;
    yes?: boolean;
}

export async function restoreCommand(snapshotName: string | undefined, opts: RestoreOptions): Promise<void> {
    const limit = positiveIntFlag(opts.last, "--last");
    // Zero and negative slip past the layout planners' `> 0` special cases and
    // silently select a different layout, so a typo must be reported, not absorbed.
    const perWorkspace = positiveIntFlag(opts.perWorkspace, "--per-workspace");

    // Asked BEFORE the scan: indexing every project's transcripts is the slow step, and
    // this is the answer that decides how much of it is worth doing.
    const scope = await resolveScope(opts, snapshotName !== undefined);
    const candidates = await gatherCandidates(snapshotName, limit, scope === "this", opts.dryRun === true);

    if (candidates.length === 0) {
        out.printlnErr(pc.yellow(snapshotName ? "That snapshot has no sessions." : "No resumable sessions found."));
        out.printlnErr(pc.dim(suggestCommand("tools claude cmux", { add: ["--last", "40"] })));
        return;
    }

    let picked = await pickSessions(candidates, opts, snapshotName !== undefined);
    let settings: RestoreSettings = {
        layout: opts.layout,
        perWorkspace,
        perProject: opts.perProject,
        newWindow: opts.newWindow === true,
        enter: opts.enter,
        autopick: opts.autopick === true,
        forceAccount: opts.account,
    };
    let plan = buildRestorePlan(picked, settings);

    // The confirmation is a menu, not a yes/no: "restore these?" is usually answered
    // "yes, but as one workspace" or "yes, without running them", and every one of
    // those adjustments is a flag the user would otherwise have to know and restart for.
    for (;;) {
        if (picked.length === 0) {
            out.printlnErr(pc.yellow("Nothing selected — nothing restored."));
            return;
        }

        plan = buildRestorePlan(picked, settings);
        printPlan(plan, settings);

        if (opts.dryRun) {
            out.printlnErr(pc.dim("--dry-run: nothing sent to cmux."));
            return;
        }

        if (opts.yes || !isInteractive()) {
            break;
        }

        const action = await p.select({
            message: `Restore ${picked.length} session${picked.length === 1 ? "" : "s"}?`,
            initialValue: "go" as TuneAction,
            options: tuneOptions(settings, plan, picked.length),
        });

        if (p.isCancel(action) || action === "cancel") {
            p.cancel("Cancelled — nothing restored.");
            return;
        }

        if (action === "go") {
            break;
        }

        if (action === "sessions") {
            picked = await pickSessions(candidates, opts, snapshotName !== undefined);
            continue;
        }

        settings = await tune(action, settings);
    }

    const spinner = p.spinner();
    spinner.start("Building workspaces...");

    let outcome: Awaited<ReturnType<typeof applyRestorePlan>>;

    try {
        outcome = await applyRestorePlan(
            plan,
            {
                enter: settings.enter,
                newWindow: settings.newWindow,
                autopick: settings.autopick,
            },
            {
                onWorkspaceStart: ({ title, index, total, panes }) => {
                    spinner.message(`[${index}/${total}] ${title} — ${panes} pane${panes === 1 ? "" : "s"}`);
                },
            }
        );
    } catch (error) {
        // The spinner never stops by itself, so an exception here would leave it
        // spinning under the stack trace, with some workspaces already built.
        spinner.stop(pc.red("Restore failed part-way through"));
        out.printlnErr(pc.dim("Workspaces created before the failure are still open."));
        throw error;
    }

    const sessions = outcome.workspaces.reduce((n, w) => n + w.sessions, 0);
    spinner.stop(
        `Restored ${sessions} session${sessions === 1 ? "" : "s"} in ${outcome.workspaces.length} workspace${outcome.workspaces.length === 1 ? "" : "s"}`
    );

    for (const workspace of outcome.workspaces) {
        out.printlnErr(`${pc.green("✔")} ${pc.bold(workspace.title)} ${pc.dim(workspace.ref)}`);
    }

    // Silence here would read as success for a session that never started.
    if (outcome.skipped.length > 0) {
        out.printlnErr(
            pc.yellow(`⚠ ${outcome.skipped.length} session${outcome.skipped.length === 1 ? "" : "s"} got no pane:`)
        );

        for (const sessionId of outcome.skipped) {
            out.printlnErr(pc.dim(`  ${sessionId.slice(0, 8)} — cmux refused the surface, resume it by hand`));
        }
    }

    if (!settings.enter) {
        out.printlnErr(pc.dim("--no-enter: each pane has its command queued at the prompt, press Enter to launch."));
    }
}

/**
 * Apply one menu choice. Each branch owns its own sub-prompt, and a cancelled
 * sub-prompt returns the settings untouched, so escape means "never mind", not "quit".
 */
async function tune(action: TuneAction, settings: RestoreSettings): Promise<RestoreSettings> {
    if (action === "layout") {
        const layout = await p.select({
            message: "Layout",
            initialValue: settings.layout,
            options: [
                { value: "capped" as LayoutMode, label: "Capped grid", hint: "extra sessions open more workspaces" },
                { value: "grid" as LayoutMode, label: "One workspace", hint: "every session becomes a pane" },
                { value: "tabs" as LayoutMode, label: "Capped grid, tabs", hint: "extra sessions become tabs" },
            ],
        });

        return p.isCancel(layout) ? settings : { ...settings, layout };
    }

    if (action === "per-workspace") {
        const value = await p.text({
            message: "Panes per workspace",
            initialValue: String(settings.perWorkspace),
            validate: (raw) => {
                const n = Number.parseInt(raw ?? "", 10);

                return Number.isFinite(n) && n > 0 ? undefined : "A positive number, please.";
            },
        });

        return p.isCancel(value) ? settings : { ...settings, perWorkspace: Number.parseInt(value, 10) };
    }

    if (action === "grouping") {
        return { ...settings, perProject: !settings.perProject };
    }

    if (action === "window") {
        return { ...settings, newWindow: !settings.newWindow };
    }

    if (action === "launch") {
        return { ...settings, enter: !settings.enter };
    }

    if (action === "accounts") {
        return tuneAccounts(settings);
    }

    return settings;
}

/** Account handling: honor the pins, auto-pick the gaps, or force one account on everything. */
async function tuneAccounts(settings: RestoreSettings): Promise<RestoreSettings> {
    const accounts = await launchableAccounts();
    const choice = await p.select({
        message: "Accounts",
        initialValue: settings.forceAccount ? "force" : settings.autopick ? "auto" : "ask",
        options: [
            { value: "ask", label: "Use the pins", hint: "unpinned panes ask which account to use" },
            { value: "auto", label: "Use the pins, auto-pick the rest", hint: "best account by usage headroom" },
            ...(accounts.length > 0
                ? [{ value: "force", label: "Force one account", hint: "every pane, pins ignored" }]
                : []),
        ],
    });

    if (p.isCancel(choice)) {
        return settings;
    }

    if (choice !== "force") {
        return { ...settings, autopick: choice === "auto", forceAccount: undefined };
    }

    const account = await p.select({
        message: "Which account?",
        initialValue: settings.forceAccount ?? accounts[0],
        options: accounts.map((name) => ({ value: name, label: name })),
    });

    return p.isCancel(account) ? settings : { ...settings, forceAccount: account, autopick: false };
}

/** Accounts `tools claude start <name>` can actually launch: those with a saved token. */
async function launchableAccounts(): Promise<string[]> {
    try {
        const config = await AIConfig.load();

        return config
            .getAccountsByProvider("anthropic-sub")
            .filter((account) => account.tokens?.longLivedToken)
            .map((account) => account.name);
    } catch (error) {
        logger.debug({ error }, "[claude-cmux] could not list accounts for the force-account menu");
        return [];
    }
}

export type SessionScope = "this" | "all";

/**
 * Which projects to offer sessions from.
 *
 * A flag always wins. Otherwise an interactive run asks, because the honest answer
 * changes with the task: reopening today's work in one repo wants this project, and
 * recovering from a crash wants every repo you had open. Non-interactive runs take
 * every project, which is the documented default.
 */
export async function resolveScope(opts: RestoreOptions, fromSnapshot: boolean): Promise<SessionScope> {
    if (opts.thisProject) {
        return "this";
    }

    // A snapshot already names its sessions, and they can come from several projects.
    if (opts.allProjects || fromSnapshot || opts.yes || !isInteractive()) {
        return "all";
    }

    const project = resolveProjectFilter();
    const picked = await p.select({
        message: "Which sessions should I offer?",
        initialValue: "all",
        options: [
            { value: "all", label: "Every project", hint: "what you had open after a crash spans repos" },
            {
                value: "this",
                label: project ? `Only ${project}` : "Only this directory's project",
                hint: "faster: it indexes one project's transcripts",
            },
        ],
    });

    if (p.isCancel(picked)) {
        p.cancel("Cancelled — nothing restored.");
        process.exit(0);
    }

    return picked as SessionScope;
}

async function gatherCandidates(
    snapshotName: string | undefined,
    limit: number,
    thisProjectOnly: boolean,
    readOnly: boolean
): Promise<RestoreCandidate[]> {
    const spinner = p.spinner();
    spinner.start(snapshotName ? `Loading snapshot "${snapshotName}"...` : "Scanning recent sessions...");

    try {
        // The snapshot holds the session set; the live scan supplies the fresh detail
        // (last prompt, rate-limit death) for the ones that still exist on disk.
        const live = await listCandidates({
            limit: snapshotName ? Math.max(limit, 200) : limit,
            // A snapshot names its own sessions, so it always scans everything.
            thisProjectOnly: snapshotName ? false : thisProjectOnly,
            readOnly,
            onProgress: (processed, total) => {
                if (total > 0) {
                    spinner.message(`Indexing transcripts ${processed}/${total}...`);
                }
            },
        });

        if (!snapshotName) {
            spinner.stop(`Found ${live.length} session${live.length === 1 ? "" : "s"}`);
            return live;
        }

        const snapshot = await loadSnapshot(snapshotName);
        const candidates = await snapshotCandidates(snapshot, live, { readOnly });
        spinner.stop(`Snapshot "${snapshot.name}" — ${candidates.length} session${candidates.length === 1 ? "" : "s"}`);

        return candidates;
    } catch (error) {
        spinner.stop(pc.red("Could not gather sessions"));
        throw error;
    }
}

async function pickSessions(
    candidates: RestoreCandidate[],
    opts: RestoreOptions,
    fromSnapshot: boolean
): Promise<RestoreCandidate[]> {
    // A snapshot IS the selection, and -y means "take what you found".
    if (opts.yes || !isInteractive()) {
        if (!opts.yes) {
            out.error(pc.red("Non-interactive: pass -y to restore without the picker."));
            out.printlnErr(suggestCommand("tools claude cmux", { add: ["-y"] }));
            process.exit(1);
        }

        return candidates;
    }

    const columns = process.stdout.columns ?? 120;
    const widths = labelWidths(candidates);
    const items = candidates.map((candidate) => ({
        value: candidate,
        label: candidateLabel(candidate, widths, columns),
        hint: candidateHint(candidate, columns),
    }));

    const selected = await searchMultiselect({
        message: fromSnapshot ? "Sessions from the snapshot (space toggles)" : "Sessions to restore (space toggles)",
        items,
        // A snapshot's whole point is "bring these back", so it starts fully selected.
        initialSelected: fromSnapshot ? candidates : [],
        maxVisible: 14,
    });

    if (selected === cancelSymbol) {
        p.cancel("Cancelled — nothing restored.");
        process.exit(0);
    }

    // The prompt returns items in the order they were TOGGLED, and a deselect-then-
    // reselect moves one to the end. Everything downstream assumes last-activity order:
    // it decides which sessions share a workspace under a cap, and which project comes
    // first. So the order is restored here rather than trusted.
    return [...(selected as RestoreCandidate[])].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function printPlan(plan: RestorePlan, settings: RestoreSettings): void {
    out.printlnErr("");

    for (const workspace of plan.workspaces) {
        const panes = workspace.panes.length;
        out.printlnErr(
            `${pc.cyan("▸")} ${pc.bold(workspace.title)} ${pc.dim(`(${panes} pane${panes === 1 ? "" : "s"})`)}`
        );

        for (const pane of workspace.panes) {
            for (const [index, session] of pane.sessions.entries()) {
                const marker = index === 0 ? "  ·" : "  +";
                const where = placeOf(session.candidate);
                const unrecorded = settings.autopick ? "auto" : "ask";
                const account = session.account ?? (session.candidate.pinned ? "keychain" : unrecorded);
                out.printlnErr(
                    `${pc.dim(marker)} ${session.candidate.sessionId.slice(0, 8)} ${pc.dim(where)} ${pc.magenta(account)}`
                );
                logger.debug(
                    { command: buildLaunchCommand(session, { autopick: settings.autopick }) },
                    "[claude-cmux] planned launch"
                );
            }
        }
    }

    out.printlnErr("");
}

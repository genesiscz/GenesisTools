import { applyRestorePlan } from "@app/claude/lib/cmux/apply";
import { buildLaunchCommand } from "@app/claude/lib/cmux/command";
import { candidateHint, candidateLabel, labelWidths, placeOf } from "@app/claude/lib/cmux/display";
import { buildRestorePlan } from "@app/claude/lib/cmux/plan";
import { listCandidates } from "@app/claude/lib/cmux/sessions";
import { loadSnapshot, snapshotCandidates } from "@app/claude/lib/cmux/snapshot";
import type { LayoutMode, RestoreCandidate, RestorePlan } from "@app/claude/lib/cmux/types";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { cancelSymbol, searchMultiselect } from "@genesiscz/utils/prompts/clack/search-multiselect";
import pc from "picocolors";

export interface RestoreOptions {
    last: string;
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
    const limit = Number.parseInt(opts.last, 10);
    const perWorkspace = Number.parseInt(opts.perWorkspace, 10);

    if (!Number.isFinite(limit) || limit <= 0) {
        out.error(pc.red(`--last must be a positive number (got "${opts.last}").`));
        process.exit(1);
    }

    // Zero and negative slip past the layout planners' `> 0` special cases and
    // silently select a different layout, so a typo must be reported, not absorbed.
    if (!Number.isFinite(perWorkspace) || perWorkspace <= 0) {
        out.error(pc.red(`--per-workspace must be a positive number (got "${opts.perWorkspace}").`));
        process.exit(1);
    }

    const candidates = await gatherCandidates(snapshotName, limit, opts.allProjects === true, opts.dryRun === true);

    if (candidates.length === 0) {
        out.printlnErr(pc.yellow(snapshotName ? "That snapshot has no sessions." : "No resumable sessions found."));
        out.printlnErr(pc.dim(suggestCommand("tools claude cmux", { add: ["--all-projects"] })));
        return;
    }

    const picked = await pickSessions(candidates, opts, snapshotName !== undefined);

    if (picked.length === 0) {
        out.printlnErr(pc.yellow("Nothing selected — nothing restored."));
        return;
    }

    const plan = buildRestorePlan(picked, {
        layout: opts.layout,
        perWorkspace,
        perProject: opts.perProject,
        forceAccount: opts.account,
    });

    printPlan(plan, opts);

    if (opts.dryRun) {
        out.printlnErr(pc.dim("--dry-run: nothing sent to cmux."));
        return;
    }

    if (!opts.yes && isInteractive()) {
        const proceed = await p.confirm({
            message: `Restore ${picked.length} session${picked.length === 1 ? "" : "s"} into ${plan.workspaces.length} workspace${plan.workspaces.length === 1 ? "" : "s"}?`,
            initialValue: true,
        });

        if (p.isCancel(proceed) || !proceed) {
            p.cancel("Cancelled — nothing restored.");
            return;
        }
    }

    const spinner = p.spinner();
    spinner.start("Building workspaces...");

    const outcome = await applyRestorePlan(
        plan,
        {
            enter: opts.enter,
            newWindow: opts.newWindow === true,
            autopick: opts.autopick,
        },
        {
            onWorkspaceStart: ({ title, index, total, panes }) => {
                spinner.message(`[${index}/${total}] ${title} — ${panes} pane${panes === 1 ? "" : "s"}`);
            },
        }
    );

    const sessions = outcome.workspaces.reduce((n, w) => n + w.sessions, 0);
    spinner.stop(
        `Restored ${sessions} session${sessions === 1 ? "" : "s"} in ${outcome.workspaces.length} workspace${outcome.workspaces.length === 1 ? "" : "s"}`
    );

    for (const workspace of outcome.workspaces) {
        out.printlnErr(`${pc.green("✔")} ${pc.bold(workspace.title)} ${pc.dim(workspace.ref)}`);
    }

    if (!opts.enter) {
        out.printlnErr(pc.dim("--no-enter: each pane has its command queued at the prompt, press Enter to launch."));
    }
}

async function gatherCandidates(
    snapshotName: string | undefined,
    limit: number,
    allProjects: boolean,
    readOnly: boolean
): Promise<RestoreCandidate[]> {
    const spinner = p.spinner();
    spinner.start(snapshotName ? `Loading snapshot "${snapshotName}"...` : "Scanning recent sessions...");

    try {
        // The snapshot holds the session set; the live scan supplies the fresh detail
        // (last prompt, rate-limit death) for the ones that still exist on disk.
        const live = await listCandidates({
            limit: snapshotName ? Math.max(limit, 200) : limit,
            allProjects: snapshotName ? true : allProjects,
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

    return selected as RestoreCandidate[];
}

function printPlan(plan: RestorePlan, opts: RestoreOptions): void {
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
                const unrecorded = opts.autopick ? "auto" : "ask";
                const account = session.account ?? (session.candidate.pinned ? "keychain" : unrecorded);
                out.printlnErr(
                    `${pc.dim(marker)} ${session.candidate.sessionId.slice(0, 8)} ${pc.dim(where)} ${pc.magenta(account)}`
                );
                logger.debug(
                    { command: buildLaunchCommand(session, { autopick: opts.autopick }) },
                    "[claude-cmux] planned launch"
                );
            }
        }
    }

    out.printlnErr("");
}

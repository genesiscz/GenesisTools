import { buildLaunchCommand, type LaunchCommandOptions, paneTitle } from "@app/claude/lib/cmux/command";
import { buildGridTree } from "@app/claude/lib/cmux/plan";
import type { PlannedPane, PlannedWorkspace, RestorePlan } from "@app/claude/lib/cmux/types";
import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import { paneList, rpc, windowList } from "@genesiscz/utils/cmux/lib/socket";
import { applySplitTree } from "@genesiscz/utils/cmux/split-tree";
import { createWorkspaceWithName } from "@genesiscz/utils/cmux/workspace";
import { logger } from "@genesiscz/utils/logger";

export interface ApplyOptions extends LaunchCommandOptions {
    /** Send the launch command with a newline. False leaves it queued at the prompt. */
    enter: boolean;
    /** Open the workspaces in a new cmux window instead of the current one. */
    newWindow: boolean;
}

export interface ApplyEvents {
    onWorkspaceStart?: (info: { title: string; index: number; total: number; panes: number }) => void;
    onWorkspaceDone?: (info: { title: string; ref: string }) => void;
}

export interface ApplyOutcome {
    workspaces: Array<{ title: string; ref: string; panes: number; sessions: number }>;
    /** Sessions cmux would not give a surface for; they were NOT launched. */
    skipped: string[];
}

export async function applyRestorePlan(
    plan: RestorePlan,
    opts: ApplyOptions,
    events: ApplyEvents = {}
): Promise<ApplyOutcome> {
    const outcome: ApplyOutcome = { workspaces: [], skipped: [] };
    const windowRef = opts.newWindow ? await createWindow() : undefined;

    for (const [index, workspace] of plan.workspaces.entries()) {
        events.onWorkspaceStart?.({
            title: workspace.title,
            index: index + 1,
            total: plan.workspaces.length,
            panes: workspace.panes.length,
        });

        const built = await materialize(workspace, windowRef, opts);
        outcome.skipped.push(...built.skipped);
        outcome.workspaces.push({
            title: workspace.title,
            ref: built.ref,
            panes: workspace.panes.length,
            sessions: workspace.panes.reduce((n, pane) => n + pane.sessions.length, 0) - built.skipped.length,
        });
        events.onWorkspaceDone?.({ title: workspace.title, ref: built.ref });
    }

    return outcome;
}

/**
 * `workspace.create` takes a window ID (a UUID), not a ref, and `window.create`'s
 * reply shape varies by build — so the new window is identified by diffing
 * `window.list` around the call. An unresolvable window is not fatal: the
 * workspaces land in the current window, which is the default anyway.
 */
async function createWindow(): Promise<string | undefined> {
    try {
        const before = new Set((await windowList()).map((w) => w.id));
        await rpc("window.create", {});
        const after = await windowList();
        const created = after.find((w) => !before.has(w.id));

        if (!created) {
            logger.warn({ windows: after.length }, "[claude-cmux] could not identify the new window");
            return undefined;
        }

        return created.id;
    } catch (error) {
        logger.warn({ error }, "[claude-cmux] window.create failed; using the current window");
        return undefined;
    }
}

async function materialize(
    workspace: PlannedWorkspace,
    windowRef: string | undefined,
    opts: ApplyOptions
): Promise<{ ref: string; skipped: string[] }> {
    const created = await createWorkspaceWithName({
        name: workspace.title,
        cwd: workspace.cwd,
        window: windowRef,
    });

    const skipped: string[] = [];

    await withFocusedWorkspace(created.workspace_ref, async () => {
        const paneRefByIndex = await applySplitTree(buildGridTree(workspace.panes.length), created.workspace_ref);

        for (const pane of workspace.panes) {
            const paneRef = paneRefByIndex.get(pane.paneIndex);

            if (!paneRef) {
                logger.warn(
                    { paneIndex: pane.paneIndex, workspace: workspace.title },
                    "[claude-cmux] pane index has no live pane — skipping its sessions"
                );
                skipped.push(...pane.sessions.map((session) => session.candidate.sessionId));
                continue;
            }

            skipped.push(...(await fillPane(pane, paneRef, created.workspace_ref, opts)));
        }
    });

    return { ref: created.workspace_ref, skipped };
}

/**
 * Launch every session assigned to one pane. The first rides the pane's own surface;
 * the rest become extra tabs in it (`tabs` layout). CLI `new-surface` rather than the
 * raw RPC, which ignores its pane parameter and stacks everything into the focused one.
 */
async function fillPane(
    pane: PlannedPane,
    paneRef: string,
    workspaceRef: string,
    opts: ApplyOptions
): Promise<string[]> {
    const layout = await paneList(workspaceRef);
    const live = layout.panes.find((p) => p.ref === paneRef);

    if (!live) {
        throw new Error(`Pane ${paneRef} disappeared mid-restore`);
    }

    const surfaceRefs = [...live.surface_refs];

    while (surfaceRefs.length < pane.sessions.length) {
        const created = await runCmuxJSON<{ surface_ref: string; pane_ref: string }>([
            "new-surface",
            "--workspace",
            workspaceRef,
            "--pane",
            paneRef,
            "--type",
            "terminal",
        ]);

        // cmux put the tab in the wrong pane. Using it anyway would start a session in a
        // pane that already holds another one, silently, with the only trace in a log
        // file. Stop adding tabs here instead: the sessions that did land are launched,
        // and the ones that did not are reported to the caller.
        if (created.pane_ref !== paneRef) {
            logger.warn(
                { requested: paneRef, got: created.pane_ref, surfaceRef: created.surface_ref },
                "[claude-cmux] new-surface landed in an unexpected pane — dropping the extra tabs"
            );
            break;
        }

        surfaceRefs.push(created.surface_ref);
    }

    const skipped: string[] = [];

    for (const [index, session] of pane.sessions.entries()) {
        const surfaceRef = surfaceRefs[index];

        // No surface means the tab above was dropped. Reusing an earlier surface would
        // start two sessions in one shell, so this one is reported instead of launched.
        if (!surfaceRef) {
            skipped.push(session.candidate.sessionId);
            continue;
        }

        await runCmuxOk(["rename-tab", "--workspace", workspaceRef, "--surface", surfaceRef, paneTitle(session)]).catch(
            (error) => {
                logger.debug({ error, surfaceRef }, "[claude-cmux] rename-tab failed");
            }
        );

        // No locale exports in front of the command. A fresh cmux pane already starts
        // with a UTF-8 LANG from the login shell (measured on cmux 0.63.2: LANG=
        // en_US.UTF-8, LC_ALL and LC_CTYPE empty, which claude renders fine), so the
        // three exports only made the line the user reads harder to read.
        const command = buildLaunchCommand(session, opts);
        const payload = `${command}${opts.enter ? "\n" : ""}`;
        logger.debug(
            { workspaceRef, surfaceRef, sessionId: session.candidate.sessionId, enter: opts.enter },
            "[claude-cmux] sending launch command"
        );
        await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, payload]);
    }

    return skipped;
}

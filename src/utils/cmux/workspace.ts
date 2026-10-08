import { findWorkspaceByName } from "@genesiscz/utils/cmux/layout";
import { type CmuxRunResult, runCmux, runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import {
    type PaneListResponse,
    paneList,
    type SurfaceSplitResult,
    type WorkspaceCreateResult,
    workspaceCreate,
} from "@genesiscz/utils/cmux/lib/socket";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { localeExportPrefix } from "@genesiscz/utils/terminal/locale";

export interface OpenSplitResult {
    paneId: string;
    surfaceId: string;
    workspaceId: string;
}

export interface BackgroundWorkspaceArgs {
    window: string;
    cwd: string;
    command: string;
    /** When false, cmux leaves the current workspace selected. */
    focus: boolean;
    name?: string;
}

/**
 * Argv for `cmux workspace create` in a window the caller names.
 *
 * `new-workspace` without `--window` opens a new macOS window when the shell is not inside
 * cmux (`identify.caller` is null). `--focus false` keeps the user's current workspace selected.
 */
export function buildWorkspaceCreateArgs(opts: BackgroundWorkspaceArgs): string[] {
    const args = [
        "workspace",
        "create",
        "--window",
        opts.window,
        "--cwd",
        opts.cwd,
        "--focus",
        opts.focus ? "true" : "false",
        "--command",
        opts.command,
    ];

    if (opts.name) {
        args.push("--name", opts.name);
    }

    return args;
}

export async function createWorkspaceWithName(opts: {
    name?: string;
    cwd?: string;
    window?: string;
}): Promise<WorkspaceCreateResult> {
    const created = await workspaceCreate(opts);

    if (opts.name) {
        await ensureWorkspaceTitle({ workspace: created.workspace_ref, window: opts.window, title: opts.name });
    }

    return created;
}

export type WorkspaceTitleOutcome = "already-set" | "renamed" | "failed";

function listedTitle(listing: unknown, workspaceRef: string): string | undefined {
    if (typeof listing !== "object" || listing === null || !("workspaces" in listing)) {
        return undefined;
    }

    const { workspaces } = listing;

    if (!Array.isArray(workspaces)) {
        return undefined;
    }

    for (const workspace of workspaces) {
        if (typeof workspace === "object" && workspace !== null && workspace.ref === workspaceRef) {
            return typeof workspace.title === "string" ? workspace.title : undefined;
        }
    }

    return undefined;
}

/**
 * Make sure a workspace carries `title`, without noise.
 *
 * `workspace create --name` already sets the title, so the usual answer is "already-set" and no rename
 * runs. The legacy `rename-workspace --workspace <ref>` right after a create failed with "Workspace ref
 * not found" (a second identical call worked), and `runCmuxOk` logged every such failure at ERROR with
 * a stack. Probed 2026-10-08: the noun form `workspace rename <ref> --title` succeeds at once. A failure
 * here is cosmetic, so it is logged at debug and reported, never thrown.
 */
export async function ensureWorkspaceTitle(
    input: { workspace: string; window?: string; title: string },
    run: (args: string[], opts?: { json?: boolean }) => Promise<CmuxRunResult> = runCmux
): Promise<WorkspaceTitleOutcome> {
    const listArgs = ["workspace", "list", ...(input.window ? ["--window", input.window] : [])];
    const listed = await run(listArgs, { json: true });

    if (listed.code === 0) {
        try {
            if (listedTitle(SafeJSON.parse(listed.stdout, { strict: true }), input.workspace) === input.title) {
                logger.debug({ workspace: input.workspace, title: input.title }, "[cmux] workspace title already set");
                return "already-set";
            }
        } catch (error) {
            logger.debug({ error, workspace: input.workspace }, "[cmux] workspace list was not JSON; renaming");
        }
    }

    const renamed = await run(["workspace", "rename", input.workspace, "--title", input.title]);

    if (renamed.code === 0) {
        return "renamed";
    }

    logger.debug(
        { workspace: input.workspace, title: input.title, code: renamed.code, stderr: renamed.stderr.trim() },
        "[cmux] workspace rename failed; the title stays as cmux set it"
    );
    return "failed";
}

export async function ensureWorkspaceByName(name: string, cwd?: string): Promise<string> {
    const existing = await findWorkspaceByName(name);

    if (existing) {
        return existing.workspaceId;
    }

    const created = await createWorkspaceWithName({ name, cwd });
    return created.workspace_ref;
}

/**
 * cmux answers `pane.list` for a workspace it cannot resolve with the ACTIVE
 * workspace's panes instead of an error. Verified 2026-08-31:
 * `list-panes --workspace workspace:999` returned workspace:3's layout, echoing
 * `"workspace_ref": "workspace:3"`. A workspace that was just created and never
 * shown takes the same path, so trusting that answer types the launch command
 * into whichever terminal the user happens to be sitting in. Compare the echoed
 * ref before believing the panes.
 */
export function anchorFromLayout(
    workspaceRef: string,
    layout: PaneListResponse
): { paneRef: string; surfaceRef: string } {
    // Only short refs are comparable; a UUID or index request echoes back as a ref.
    if (workspaceRef.startsWith("workspace:") && layout.workspace_ref && layout.workspace_ref !== workspaceRef) {
        throw new Error(
            `cmux answered pane.list for ${layout.workspace_ref} when asked about ${workspaceRef} — ` +
                `select the workspace before asking for its panes`
        );
    }

    const panes = layout.panes;

    if (panes.length === 0) {
        throw new Error(`Workspace ${workspaceRef} has no panes`);
    }

    const focused = panes.find((pane) => pane.focused) ?? panes[0];
    const surfaceRef = focused.selected_surface_ref ?? focused.surface_refs?.[0];

    if (!surfaceRef) {
        throw new Error(`Pane ${focused.ref} has no surfaces`);
    }

    return { paneRef: focused.ref, surfaceRef };
}

export async function pickAnchorSurface(workspaceRef: string): Promise<{ paneRef: string; surfaceRef: string }> {
    return anchorFromLayout(workspaceRef, await paneList(workspaceRef));
}

export async function openSplitInWorkspace(workspaceRef: string): Promise<OpenSplitResult> {
    return withFocusedWorkspace(workspaceRef, async () => {
        const { surfaceRef } = await pickAnchorSurface(workspaceRef);
        const split = await runCmuxJSON<SurfaceSplitResult>([
            "new-split",
            "right",
            "--workspace",
            workspaceRef,
            "--surface",
            surfaceRef,
        ]);

        return {
            workspaceId: workspaceRef,
            paneId: split.pane_ref,
            surfaceId: split.surface_ref,
        };
    });
}

export async function openSurfaceInPane(workspaceRef: string, paneRef: string): Promise<{ surfaceId: string }> {
    return withFocusedWorkspace(workspaceRef, async () => {
        const created = await runCmuxJSON<{ surface_ref: string }>([
            "new-surface",
            "--workspace",
            workspaceRef,
            "--pane",
            paneRef,
            "--type",
            "terminal",
        ]);

        return { surfaceId: created.surface_ref };
    });
}

async function sendShellCommand(workspaceRef: string, surfaceRef: string, command: string): Promise<void> {
    const payload = `${localeExportPrefix()}${command}\n`;
    await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, payload]);
}

export async function sendAttachCommand({
    workspaceRef,
    surfaceRef,
    tmuxSessionName,
}: {
    workspaceRef: string;
    surfaceRef: string;
    tmuxSessionName: string;
}): Promise<void> {
    await sendShellCommand(workspaceRef, surfaceRef, `exec tmux attach-session -t ${shellQuote(tmuxSessionName)}`);
}

export async function sendNewSessionCommand({
    workspaceRef,
    surfaceRef,
    tmuxSessionName,
    cwd,
}: {
    workspaceRef: string;
    surfaceRef: string;
    tmuxSessionName: string;
    cwd: string;
}): Promise<void> {
    await sendShellCommand(
        workspaceRef,
        surfaceRef,
        // `cd ~` first: if this client starts the tmux server, the server keeps its folder for
        // life, and a worktree that is removed later poisons every new pane (tmuxServerBootstrapCwd).
        `cd ~ && exec tmux new-session -A -s ${shellQuote(tmuxSessionName)} -c ${shellQuote(cwd)}`
    );
}

export async function renameSurfaceTab(workspaceRef: string, surfaceRef: string, title: string): Promise<void> {
    await runCmuxOk(["rename-tab", "--workspace", workspaceRef, "--surface", surfaceRef, title]);
}

export async function assertTerminalSurface(workspaceRef: string, paneRef: string, surfaceRef: string): Promise<void> {
    const surfaces = await runCmuxJSON<{ surfaces?: Array<{ ref?: string; type?: string }> }>([
        "list-pane-surfaces",
        "--workspace",
        workspaceRef,
        "--pane",
        paneRef,
    ]);
    const surface = (surfaces.surfaces ?? []).find((candidate) => (candidate.ref ?? "") === surfaceRef);

    if (!surface) {
        throw new Error(`Surface ${surfaceRef} not found in pane ${paneRef}`);
    }

    if (surface.type && surface.type !== "terminal") {
        throw new Error(`Surface ${surfaceRef} is not a terminal (type=${surface.type})`);
    }
}

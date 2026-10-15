import { findWorkspaceByName } from "@genesiscz/utils/cmux/layout";
import { type CmuxRunResult, runCmux, runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import {
    assertLayoutIsFor,
    type PaneListResponse,
    paneList,
    type SurfaceSplitResult,
    type WorkspaceCreateResult,
    workspaceCreate,
} from "@genesiscz/utils/cmux/lib/socket";
import { sameCmuxId } from "@genesiscz/utils/cmux/lib/target";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { localeExportPrefix } from "@genesiscz/utils/terminal/locale";

/** UUIDs of the new pane and surface, and of the workspace that holds them. */
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

/** Create a workspace and apply its requested title using the returned workspace UUID. */
export async function createWorkspaceWithName(opts: {
    name?: string;
    cwd?: string;
    window?: string;
}): Promise<WorkspaceCreateResult> {
    const created = await workspaceCreate(opts);

    if (opts.name) {
        await ensureWorkspaceTitle({ workspace: created.workspace_id, window: opts.window, title: opts.name });
    }

    return created;
}

export type WorkspaceTitleOutcome = "already-set" | "renamed" | "failed";

function listedTitle(listing: unknown, workspaceId: string): string | undefined {
    if (typeof listing !== "object" || listing === null || !("workspaces" in listing)) {
        return undefined;
    }

    const { workspaces } = listing;

    if (!Array.isArray(workspaces)) {
        return undefined;
    }

    for (const workspace of workspaces) {
        if (
            typeof workspace === "object" &&
            workspace !== null &&
            typeof workspace.id === "string" &&
            sameCmuxId(workspace.id, workspaceId)
        ) {
            return typeof workspace.title === "string" ? workspace.title : undefined;
        }
    }

    return undefined;
}

/**
 * Make sure a workspace carries `title`, without noise. `input.workspace` is the workspace UUID.
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

/** Reuse an exact workspace-name match or create the named workspace and return its UUID. */
export async function ensureWorkspaceByName(name: string, cwd?: string): Promise<string> {
    const existing = await findWorkspaceByName(name);

    if (existing) {
        return existing.workspaceId;
    }

    const created = await createWorkspaceWithName({ name, cwd });
    return created.workspace_id;
}

/**
 * The pane and surface UUIDs a command typed into `workspace` should land in: the focused pane's
 * selected surface.
 *
 * cmux answers `pane.list` for a workspace it cannot resolve with the ACTIVE workspace's panes, so
 * the echoed workspace is compared first (`assertLayoutIsFor`). A workspace that was just created
 * and never shown takes that path, and trusting the answer typed the launch command into whichever
 * terminal the user happened to be sitting in (2026-08-31).
 */
export function anchorFromLayout(workspace: string, layout: PaneListResponse): { paneId: string; surfaceId: string } {
    assertLayoutIsFor(workspace, layout);

    const panes = layout.panes;

    if (panes.length === 0) {
        throw new Error(`Workspace ${workspace} has no panes`);
    }

    const focused = panes.find((pane) => pane.focused) ?? panes[0];
    const surfaceId = focused.selected_surface_id ?? focused.surface_ids?.[0];

    if (!surfaceId) {
        throw new Error(`Pane ${focused.ref} has no surfaces`);
    }

    return { paneId: focused.id, surfaceId };
}

/** Resolve a terminal anchor from the target workspace's validated pane layout for subsequent split operations. */
export async function pickAnchorSurface(workspaceId: string): Promise<{ paneId: string; surfaceId: string }> {
    return anchorFromLayout(workspaceId, await paneList(workspaceId));
}

/**
 * Create a right-hand terminal split from the target workspace's anchor and return the created UUIDs.
 *
 * `background: true` skips the select-and-switch-back around the call: cmux 0.65 creates splits and tabs without
 * focus by default and accepts input in a workspace that was never shown (probed 2026-10-15), so the switch only
 * flickers the user's view. The default keeps the old guard for callers that never asked.
 */
export async function openSplitInWorkspace(
    workspaceId: string,
    options: { background?: boolean } = {}
): Promise<OpenSplitResult> {
    const split = async () => {
        const { surfaceId } = await pickAnchorSurface(workspaceId);
        const split = await runCmuxJSON<SurfaceSplitResult>([
            "new-split",
            "right",
            "--workspace",
            workspaceId,
            "--surface",
            surfaceId,
        ]);

        return {
            workspaceId: split.workspace_id,
            paneId: split.pane_id,
            surfaceId: split.surface_id,
        };
    };

    return options.background ? split() : withFocusedWorkspace(workspaceId, split);
}

/**
 * Create a terminal tab inside an explicitly identified workspace and pane, returning its surface UUID.
 * `background: true` skips the select-and-switch-back, as for {@link openSplitInWorkspace}.
 */
export async function openSurfaceInPane(
    workspaceId: string,
    paneId: string,
    options: { background?: boolean } = {}
): Promise<{ surfaceId: string }> {
    const create = async () => {
        const created = await runCmuxJSON<Pick<SurfaceSplitResult, "surface_id">>([
            "new-surface",
            "--workspace",
            workspaceId,
            "--pane",
            paneId,
            "--type",
            "terminal",
        ]);

        return { surfaceId: created.surface_id };
    };

    return options.background ? create() : withFocusedWorkspace(workspaceId, create);
}

async function sendShellCommand(workspaceId: string, surfaceId: string, command: string): Promise<void> {
    const payload = `${localeExportPrefix()}${command}\n`;
    await runCmuxOk(["send", "--workspace", workspaceId, "--surface", surfaceId, payload]);
}

/** Replace the target terminal shell with a quoted attachment to the named tmux session. */
export async function sendAttachCommand({
    workspaceId,
    surfaceId,
    tmuxSessionName,
}: {
    workspaceId: string;
    surfaceId: string;
    tmuxSessionName: string;
}): Promise<void> {
    await sendShellCommand(workspaceId, surfaceId, `exec tmux attach-session -t ${shellQuote(tmuxSessionName)}`);
}

/** Start or attach a tmux session from a stable bootstrap directory while giving the session its requested cwd. */
export async function sendNewSessionCommand({
    workspaceId,
    surfaceId,
    tmuxSessionName,
    cwd,
}: {
    workspaceId: string;
    surfaceId: string;
    tmuxSessionName: string;
    cwd: string;
}): Promise<void> {
    await sendShellCommand(
        workspaceId,
        surfaceId,
        // `cd ~` first: if this client starts the tmux server, the server keeps its folder for
        // life, and a worktree that is removed later poisons every new pane (tmuxServerBootstrapCwd).
        `cd ~ && exec tmux new-session -A -s ${shellQuote(tmuxSessionName)} -c ${shellQuote(cwd)}`
    );
}

/** Rename only the terminal tab identified by its workspace and surface UUIDs. */
export async function renameSurfaceTab(workspaceId: string, surfaceId: string, title: string): Promise<void> {
    await runCmuxOk(["rename-tab", "--workspace", workspaceId, "--surface", surfaceId, title]);
}

/** Reject a missing or non-terminal surface before sending commands to the requested pane. */
export async function assertTerminalSurface(workspaceId: string, paneId: string, surfaceId: string): Promise<void> {
    const surfaces = await runCmuxJSON<{ surfaces?: Array<{ id?: string; ref?: string; type?: string }> }>([
        "list-pane-surfaces",
        "--workspace",
        workspaceId,
        "--pane",
        paneId,
    ]);
    const surface = (surfaces.surfaces ?? []).find((candidate) => sameCmuxId(candidate.id, surfaceId));

    if (!surface) {
        throw new Error(`Surface ${surfaceId} not found in pane ${paneId}`);
    }

    if (surface.type && surface.type !== "terminal") {
        throw new Error(`Surface ${surface.ref ?? surfaceId} is not a terminal (type=${surface.type})`);
    }
}

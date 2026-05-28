import { runCmuxJSON, runCmuxOk } from "@app/cmux/lib/cli";
import { withFocusedWorkspace } from "@app/cmux/lib/focus-guard";
import { paneList, type SurfaceSplitResult, workspaceCreate } from "@app/cmux/lib/socket";
import { logger } from "@app/logger";
import { findWorkspaceByName } from "@app/utils/cmux/layout";
import { localeExportPrefix } from "@app/utils/terminal/locale";

export interface OpenSplitResult {
    paneId: string;
    surfaceId: string;
    workspaceId: string;
}

export async function ensureWorkspaceByName(name: string, cwd?: string): Promise<string> {
    const existing = await findWorkspaceByName(name);

    if (existing) {
        return existing.workspaceId;
    }

    const created = await workspaceCreate({ name, cwd });
    try {
        await runCmuxOk(["rename-workspace", "--workspace", created.workspace_ref, name]);
    } catch (error) {
        logger.warn({ error, workspaceRef: created.workspace_ref, name }, "rename-workspace failed after create");
    }

    return created.workspace_ref;
}

async function pickAnchorSurface(workspaceRef: string): Promise<{ paneRef: string; surfaceRef: string }> {
    const layout = await paneList(workspaceRef);
    const panes = layout.panes;

    if (panes.length === 0) {
        throw new Error(`Workspace ${workspaceRef} has no panes`);
    }

    const focused = panes.find((pane) => pane.focused) ?? panes[0];
    const surfaceRef = focused.selected_surface_ref ?? focused.surface_refs[0];

    if (!surfaceRef) {
        throw new Error(`Pane ${focused.ref} has no surfaces`);
    }

    return { paneRef: focused.ref, surfaceRef };
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

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
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
    const payload = `${localeExportPrefix()}exec tmux attach-session -t ${shellQuote(tmuxSessionName)}\n`;
    await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, payload]);
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
    const payload = `${localeExportPrefix()}exec tmux new-session -A -s ${shellQuote(tmuxSessionName)} -c ${shellQuote(cwd)}\n`;
    await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, payload]);
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

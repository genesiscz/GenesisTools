import { type CmuxRunResult, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { rpc } from "@genesiscz/utils/cmux/lib/socket";

type CmuxCommandRunner = (args: string[]) => Promise<CmuxRunResult>;

interface FocusCmuxPaneOptions {
    workspaceId: string;
    paneId: string;
    runner?: CmuxCommandRunner;
}

function assertNonBlank(value: string, name: string): void {
    if (!value.trim()) {
        throw new Error(`${name} is required`);
    }
}

export async function focusCmuxPane({ paneId, runner = runCmuxOk, workspaceId }: FocusCmuxPaneOptions): Promise<void> {
    assertNonBlank(workspaceId, "workspaceId");
    assertNonBlank(paneId, "paneId");

    await runner(["select-workspace", "--workspace", workspaceId]);
    await runner(["focus-pane", "--workspace", workspaceId, "--pane", paneId]);
}

/**
 * Make `surfaceId` the visible tab inside its pane.
 *
 * `focus-pane` leaves whatever tab was already selected on top, so focusing a pane is not
 * enough when the thing you were looking for lives on a background surface.
 *
 * There is no CLI verb for this. `cmux --help` lists no focus-surface command, and
 * `tab-action --action focus` answers `invalid_params: Unknown tab action` (verified against
 * cmux 0.63.2), so this goes through the raw `surface.focus` RPC. Its parameter is
 * `surface_id`; passing `surface` fails with `Missing or invalid surface_id`.
 */
export async function focusCmuxSurface(surfaceId: string): Promise<void> {
    assertNonBlank(surfaceId, "surfaceId");

    await rpc("surface.focus", { surface_id: surfaceId });
}

// `pane.workspaceId` and `surface.id` from the live snapshot are already the
// cmux refs the CLI expects (`workspace.ref ?? workspace.id`,
// `surface.ref ?? surface.id`), so they pass straight through — no separate
// ref-resolution step like `focusCmuxPane` needs for panes.
export function buildRenameTabArgs(workspaceRef: string, surfaceRef: string, title: string): string[] {
    return ["rename-tab", "--workspace", workspaceRef, "--surface", surfaceRef, title];
}

export function buildRenameWorkspaceArgs(workspaceRef: string, title: string): string[] {
    return ["rename-workspace", "--workspace", workspaceRef, title];
}

export async function renameCmuxSurface(
    input: { workspaceId: string; surfaceId: string; title: string },
    runner: CmuxCommandRunner = runCmuxOk
): Promise<void> {
    assertNonBlank(input.workspaceId, "workspaceId");
    assertNonBlank(input.surfaceId, "surfaceId");
    assertNonBlank(input.title, "title");

    await runner(buildRenameTabArgs(input.workspaceId, input.surfaceId, input.title));
}

export async function renameCmuxWorkspace(
    input: { workspaceId: string; title: string },
    runner: CmuxCommandRunner = runCmuxOk
): Promise<void> {
    assertNonBlank(input.workspaceId, "workspaceId");
    assertNonBlank(input.title, "title");

    await runner(buildRenameWorkspaceArgs(input.workspaceId, input.title));
}

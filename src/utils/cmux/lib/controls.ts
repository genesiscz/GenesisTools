import { type CmuxRunResult, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { rpc } from "@genesiscz/utils/cmux/lib/socket";

type CmuxCommandRunner = (args: string[]) => Promise<CmuxRunResult>;

type CmuxRpcSender = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface FocusCmuxPaneOptions {
    /** Workspace and pane UUIDs. */
    workspaceId: string;
    paneId: string;
    runner?: CmuxCommandRunner;
}

interface FocusCmuxSurfaceOptions {
    surfaceId: string;
    /** Injectable so a test can pin the method name and parameter without a live daemon. */
    sendRpc?: CmuxRpcSender;
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
export async function focusCmuxSurface({ surfaceId, sendRpc = rpc }: FocusCmuxSurfaceOptions): Promise<void> {
    assertNonBlank(surfaceId, "surfaceId");

    await sendRpc("surface.focus", { surface_id: surfaceId });
}

// Every id here is the cmux UUID, which is what the live snapshot and the layout carry as `id`.
// cmux takes a UUID wherever it takes a ref, and unlike `surface:N` it survives a relaunch.
export function buildRenameTabArgs(workspaceId: string, surfaceId: string, title: string): string[] {
    return ["rename-tab", "--workspace", workspaceId, "--surface", surfaceId, title];
}

export function buildRenameWorkspaceArgs(workspaceId: string, title: string): string[] {
    return ["rename-workspace", "--workspace", workspaceId, title];
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

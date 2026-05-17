import { type CmuxRunResult, runCmuxOk } from "@app/cmux/lib/cli";

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

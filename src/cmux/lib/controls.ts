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

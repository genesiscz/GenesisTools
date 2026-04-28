import logger from "@app/logger";
import { runCmuxJSON, runCmuxOk } from "@app/cmux/lib/cli";

interface IdentifyFocused {
    workspace_ref?: string;
}

interface IdentifyResponse {
    focused?: IdentifyFocused;
}

const FOCUS_SETTLE_MS = 400;

async function getFocusedWorkspaceRef(): Promise<string | undefined> {
    const identify = await runCmuxJSON<IdentifyResponse>(["identify"]);
    return identify.focused?.workspace_ref;
}

async function selectWorkspace(ref: string): Promise<void> {
    await runCmuxOk(["select-workspace", "--workspace", ref]);
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFocusedWorkspace<T>(workspaceRef: string, fn: () => Promise<T>): Promise<T> {
    const previous = await getFocusedWorkspaceRef();
    const needSwitch = previous !== workspaceRef;

    if (needSwitch) {
        logger.debug({ from: previous, to: workspaceRef }, "[focus-guard] switching workspace");
        await selectWorkspace(workspaceRef);
        await sleep(FOCUS_SETTLE_MS);
    }

    try {
        return await fn();
    } finally {
        if (needSwitch && previous && previous !== workspaceRef) {
            try {
                await selectWorkspace(previous);
            } catch (error) {
                logger.warn({ error, previous }, "[focus-guard] failed to restore previous workspace");
            }
        }
    }
}

import { runCmuxJSON, runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { sameCmuxId } from "@genesiscz/utils/cmux/lib/target";
import { logger } from "@genesiscz/utils/logger";

interface IdentifyFocused {
    workspace_id?: string;
}

interface IdentifyResponse {
    focused?: IdentifyFocused;
}

const FOCUS_SETTLE_MS = 400;

/** `identify` reports refs only unless asked for both forms. */
async function getFocusedWorkspaceId(): Promise<string | undefined> {
    const identify = await runCmuxJSON<IdentifyResponse>(["--id-format", "both", "identify"]);
    return identify.focused?.workspace_id;
}

async function selectWorkspace(workspaceId: string): Promise<void> {
    await runCmuxOk(["select-workspace", "--workspace", workspaceId]);
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with `workspaceId` (a workspace UUID) selected, then select the previous one again.
 * Compared by UUID: a `workspace:N` ref from before a cmux relaunch can name the focused workspace
 * while meaning another one, and the switch would be skipped.
 */
export async function withFocusedWorkspace<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = await getFocusedWorkspaceId();
    const needSwitch = !sameCmuxId(previous, workspaceId);

    if (needSwitch) {
        logger.debug({ from: previous, to: workspaceId }, "[focus-guard] switching workspace");
        await selectWorkspace(workspaceId);
        await sleep(FOCUS_SETTLE_MS);
    }

    try {
        return await fn();
    } finally {
        if (needSwitch && previous) {
            try {
                await selectWorkspace(previous);
            } catch (error) {
                logger.warn({ error, previous }, "[focus-guard] failed to restore previous workspace");
            }
        }
    }
}

import { retargetTtydTmuxBindings, syncTtydDisplayNamesForTmux } from "@app/dev-dashboard/lib/ttyd/manager";
import { renameTmuxSession } from "@genesiscz/utils/tmux/sessions";

/**
 * Rename a live tmux session and keep every dashboard surface in sync:
 * relaunch bound ttyd processes so `attach-session -t` tracks the new name, and
 * mirror the name onto ttyd display labels so tabs match Session Hub.
 */
export async function renameTmuxSessionInHub(fromName: string, toName: string): Promise<string> {
    const trimmed = toName.trim();

    if (!trimmed) {
        throw new Error("Destination tmux session name cannot be empty.");
    }

    await renameTmuxSession(fromName, trimmed);
    await retargetTtydTmuxBindings(fromName, trimmed);
    await syncTtydDisplayNamesForTmux(trimmed, trimmed);

    return trimmed;
}

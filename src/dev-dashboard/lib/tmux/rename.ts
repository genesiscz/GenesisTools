import { retargetTtydTmuxBindings } from "@app/dev-dashboard/lib/ttyd/manager";
import { renameTmuxSession } from "@app/utils/tmux/sessions";

export async function renameTmuxSessionInHub(fromName: string, toName: string): Promise<string> {
    const trimmed = toName.trim();

    if (!trimmed) {
        throw new Error("Destination tmux session name cannot be empty.");
    }

    renameTmuxSession(fromName, trimmed);
    await retargetTtydTmuxBindings(fromName, trimmed);

    return trimmed;
}

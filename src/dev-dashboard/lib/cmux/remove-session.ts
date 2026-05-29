import { runCmuxOk } from "@app/cmux/lib/cli";
import { fetchCmuxFullLayout } from "@app/utils/cmux/layout";
import { findCmuxSurfacesForTmuxSession } from "@app/utils/cmux/tmux-bindings";

export async function removeTmuxSessionFromCmux(tmuxSessionName: string): Promise<number> {
    const layout = await fetchCmuxFullLayout();

    if (!layout.available) {
        throw new Error(layout.error ?? "Failed to load cmux layout");
    }

    const bindings = findCmuxSurfacesForTmuxSession(layout, tmuxSessionName);

    for (const binding of bindings) {
        await runCmuxOk(["close-surface", "--workspace", binding.workspaceId, "--surface", binding.surfaceId]);
    }

    return bindings.length;
}

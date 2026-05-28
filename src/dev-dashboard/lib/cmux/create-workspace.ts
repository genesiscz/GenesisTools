import { runCmuxOk } from "@app/cmux/lib/cli";
import { workspaceCreate } from "@app/cmux/lib/socket";
import { logger } from "@app/logger";

export async function createCmuxWorkspace(opts: {
    windowId: string;
    name?: string;
    cwd?: string;
}): Promise<{ workspaceId: string; windowId: string }> {
    const created = await workspaceCreate({
        name: opts.name,
        cwd: opts.cwd,
        window: opts.windowId,
    });

    if (opts.name) {
        try {
            await runCmuxOk(["rename-workspace", "--workspace", created.workspace_ref, opts.name]);
        } catch (error) {
            logger.warn(
                { error, workspaceRef: created.workspace_ref, name: opts.name },
                "rename-workspace failed after create"
            );
        }
    }

    return {
        workspaceId: created.workspace_ref,
        windowId: created.window_ref,
    };
}

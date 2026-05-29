import { createWorkspaceWithName } from "@app/utils/cmux/workspace";

export async function createCmuxWorkspace(opts: {
    windowId: string;
    name?: string;
    cwd?: string;
}): Promise<{ workspaceId: string; windowId: string }> {
    const created = await createWorkspaceWithName({
        name: opts.name,
        cwd: opts.cwd,
        window: opts.windowId,
    });

    return {
        workspaceId: created.workspace_ref,
        windowId: created.window_ref,
    };
}

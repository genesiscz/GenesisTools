import { runCmuxOk } from "@genesiscz/utils/cmux/lib/cli";
import { createWorkspaceWithName, pickAnchorSurface } from "@genesiscz/utils/cmux/workspace";
import { logger } from "@genesiscz/utils/logger";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import type { TerminalDriver, TerminalTarget } from "./types";

/** cmux needs this pause after select-workspace before a new PTY accepts keys. */
const SETTLE_MS = 400;

const log = logger.child({ component: "open-in/cmux" });

/** The cmux calls the driver makes; injected so tests never touch a live cmux. */
export interface CmuxOps {
    createWorkspace(opts: { name?: string; cwd: string }): Promise<{ workspaceRef: string }>;
    selectWorkspace(workspaceRef: string): Promise<void>;
    anchorSurface(workspaceRef: string): Promise<{ surfaceRef: string }>;
    send(opts: { workspaceRef: string; surfaceRef: string; text: string }): Promise<void>;
    settle(ms: number): Promise<void>;
}

export const liveCmuxOps: CmuxOps = {
    async createWorkspace(opts) {
        const created = await createWorkspaceWithName(opts);
        return { workspaceRef: created.workspace_ref };
    },
    async selectWorkspace(workspaceRef) {
        await runCmuxOk(["select-workspace", "--workspace", workspaceRef]);
    },
    async anchorSurface(workspaceRef) {
        const anchor = await pickAnchorSurface(workspaceRef);
        return { surfaceRef: anchor.surfaceRef };
    },
    async send({ workspaceRef, surfaceRef, text }) {
        await runCmuxOk(["send", "--workspace", workspaceRef, "--surface", surfaceRef, text]);
    },
    settle: (ms) => Bun.sleep(ms),
};

/** The line typed into the new terminal: every argv element single-quoted on its own. */
export function cmuxCommandLine(target: TerminalTarget): string | null {
    return target.argv && target.argv.length > 0 ? `${shellCommandLine(target.argv)}\n` : null;
}

/**
 * A new cmux workspace at `cwd`. A new workspace is never shown yet, and cmux answers `pane.list`
 * for an unshown workspace with the ACTIVE one's panes, so it is selected before its anchor
 * surface is asked for (see `anchorFromLayout` in `@genesiscz/utils/cmux/workspace`).
 */
export function cmuxDriver({ ops = liveCmuxOps }: { ops?: CmuxOps } = {}): TerminalDriver {
    return {
        kind: "terminal",
        id: "cmux",
        label: "cmux",
        async open(target) {
            const { workspaceRef } = await ops.createWorkspace({ name: target.title, cwd: target.cwd });
            await ops.selectWorkspace(workspaceRef);
            const line = cmuxCommandLine(target);
            log.info({ workspaceRef, cwd: target.cwd, argv0: target.argv?.[0] ?? null }, "cmux workspace opened");

            if (!line) {
                return { driver: "cmux", detail: `${workspaceRef} at ${target.cwd}` };
            }

            await ops.settle(SETTLE_MS);
            const { surfaceRef } = await ops.anchorSurface(workspaceRef);
            await ops.send({ workspaceRef, surfaceRef, text: line });
            return { driver: "cmux", detail: `${workspaceRef} ${surfaceRef} at ${target.cwd}` };
        },
    };
}

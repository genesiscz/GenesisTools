import { type CmuxTree, cmuxTreeFromJson, readCmuxTree } from "@genesiscz/utils/cmux/tree-read";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The live layout from the one tree read (`tree-read.ts`): every terminal tab with its surface, pane,
 * workspace and window UUIDs, its tty and title, and the caller's tab. The restore, adoption, close and focus
 * checks all read it here. The profile capture (snapshot.ts) keeps its own `list-panes` reads, because the tree
 * carries no pane geometry (frames, columns, rows).
 */

export interface LiveSurface {
    ref: string;
    /** The surface UUID (`--id-format both`); stable across cmux restarts, unlike `ref`. */
    id: string | null;
    tty: string | null;
    workspace: string;
    /** The workspace UUID (`--id-format both`); stable across cmux restarts, unlike `workspace`. */
    workspaceId: string | null;
    window: string;
    /** The pane and window UUIDs, where the tree named them. */
    paneId?: string | null;
    windowId?: string | null;
    /** The tab title (`vybava - grok`). */
    title: string | null;
    workspaceTitle: string | null;
}

export interface CmuxTreeView {
    /** The surface this command runs in, as a ref; never adopted. */
    caller: string | null;
    /** The same surface's UUID, which survives a cmux relaunch (`--id-format both`). */
    callerId: string | null;
    surfaces: Map<string, LiveSurface>;
}

function text(value: string | null): string | null {
    return value !== null && value !== "" ? value : null;
}

/** The terminal surfaces of a tree read, keyed by ref, with their UUID, tty, workspace and window. */
export function cmuxTreeView(tree: CmuxTree): CmuxTreeView {
    const surfaces = new Map<string, LiveSurface>();

    for (const window of tree.windows) {
        const windowRef = text(window.ref);

        if (!windowRef) {
            continue;
        }

        for (const workspace of window.workspaces) {
            const workspaceRef = text(workspace.ref);

            if (!workspaceRef) {
                continue;
            }

            for (const pane of workspace.panes) {
                for (const surface of pane.surfaces ?? []) {
                    const ref = text(surface.ref);

                    if (ref && surface.type === "terminal") {
                        surfaces.set(ref, {
                            ref,
                            id: text(surface.id),
                            tty: text(surface.tty),
                            workspace: workspaceRef,
                            workspaceId: text(workspace.id),
                            window: windowRef,
                            paneId: text(pane.id),
                            windowId: text(window.id),
                            title: text(surface.title),
                            workspaceTitle: text(workspace.title),
                        });
                    }
                }
            }
        }
    }

    return {
        caller: text(tree.caller?.surfaceRef ?? null),
        callerId: text(tree.caller?.surfaceId ?? null),
        surfaces,
    };
}

/** `cmuxTreeView` over the stdout of `cmux --json --id-format both tree`; a fixture's way in. */
export function parseCmuxTree(stdout: string): CmuxTreeView {
    const tree = cmuxTreeFromJson(SafeJSON.parse(stdout, { strict: true }));
    return tree ? cmuxTreeView(tree) : { caller: null, callerId: null, surfaces: new Map() };
}

/**
 * Every terminal surface of every cmux window, with its UUID and tty. Reads in the background; it never changes
 * focus. Throws when the read failed (timed out, failed, or backed off): a wedged cmux is not a cmux with no tabs.
 */
export async function liveTree(): Promise<CmuxTreeView> {
    const read = await readCmuxTree();

    if (!read.ok) {
        throw new Error(`cmux tree read (${read.reason}): ${read.error}`);
    }

    return cmuxTreeView(read.tree);
}

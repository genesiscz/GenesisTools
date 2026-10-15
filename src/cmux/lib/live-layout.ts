import { runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The live layout from one `cmux --id-format both tree --all`: every terminal tab with its surface, pane,
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** The terminal surfaces of `cmux --id-format both tree --json`, keyed by ref, with their UUID, tty, workspace and window. */
export function parseCmuxTree(stdout: string): CmuxTreeView {
    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });
    const surfaces = new Map<string, LiveSurface>();

    if (!isRecord(parsed)) {
        return { caller: null, callerId: null, surfaces };
    }

    const caller = isRecord(parsed.caller) ? text(parsed.caller.surface_ref) : null;
    const callerId = isRecord(parsed.caller) ? text(parsed.caller.surface_id) : null;

    for (const window of list(parsed.windows)) {
        if (!isRecord(window) || !text(window.ref)) {
            continue;
        }

        for (const workspace of list(window.workspaces)) {
            if (!isRecord(workspace) || !text(workspace.ref)) {
                continue;
            }

            for (const pane of list(workspace.panes)) {
                if (!isRecord(pane)) {
                    continue;
                }

                for (const surface of list(pane.surfaces)) {
                    const ref = isRecord(surface) ? text(surface.ref) : null;

                    if (isRecord(surface) && ref && surface.type === "terminal") {
                        surfaces.set(ref, {
                            ref,
                            id: text(surface.id),
                            tty: text(surface.tty),
                            workspace: String(workspace.ref),
                            workspaceId: text(workspace.id),
                            window: String(window.ref),
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

    return { caller, callerId, surfaces };
}

/** Every terminal surface of every cmux window, with its UUID and tty. Reads in the background; it never changes focus. */
export async function liveTree(): Promise<CmuxTreeView> {
    // The surface UUIDs let adoption tell a session's own surface from a renumbered ref.
    const result = await runCmux(["--id-format", "both", "tree", "--all"], { json: true });

    if (result.code !== 0) {
        throw new Error(`cmux tree failed (${result.code}): ${result.stderr.trim()}`);
    }

    return parseCmuxTree(result.stdout);
}

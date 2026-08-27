import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveWindow } from "@genesiscz/utils/cmux/lib/live-snapshot";

/**
 * Shape a flat live snapshot into the window → workspace → pane hierarchy.
 * Pure structure, no claude concepts — session annotation layers on top
 * (see src/claude/lib/cmux/tree.ts).
 */

export interface CmuxHierarchyWorkspace {
    id: string;
    name: string;
    panes: CmuxLivePane[];
}

export interface CmuxHierarchyWindow {
    id: string;
    ref?: string;
    index: number;
    key: boolean;
    workspaces: CmuxHierarchyWorkspace[];
}

export function buildCmuxHierarchy(snapshot: CmuxLiveSnapshot): CmuxHierarchyWindow[] {
    // Windows come from list-windows in allWindows mode; a single-window snapshot
    // (older cmux, or the default mode) collapses into one synthetic window that
    // owns every workspace, so there is nothing to distribute.
    const listed = snapshot.windows ?? [];
    const windowMetas: CmuxLiveWindow[] = listed.length
        ? listed
        : [{ id: "window:current", index: 0, key: true, workspaceCount: snapshot.workspaces.length }];

    const windows: CmuxHierarchyWindow[] = windowMetas.map((meta) => {
        const workspaces = listed.length
            ? snapshot.workspaces.filter((ws) => {
                  // Compare refs only when BOTH sides have one: with several windows
                  // carrying no ref, `ws.windowRef === meta.ref` was undefined ===
                  // undefined, which put every unreferenced workspace in every window.
                  if (ws.windowRef && meta.ref) {
                      return ws.windowRef === meta.ref;
                  }

                  return !ws.windowRef && meta.key;
              })
            : snapshot.workspaces;

        return {
            id: meta.id,
            ref: meta.ref,
            index: meta.index,
            key: meta.key,
            workspaces: workspaces.map((ws) => ({
                id: ws.id,
                name: ws.name,
                panes: snapshot.panes.filter((p) => p.workspaceId === ws.id),
            })),
        };
    });

    // A pane whose workspaceId matches no listed workspace would silently vanish;
    // surface those under the key window so consumers never hide live panes.
    const placed = new Set(windows.flatMap((w) => w.workspaces.flatMap((ws) => ws.panes.map((p) => p.id))));
    const orphans = snapshot.panes.filter((p) => !placed.has(p.id));

    if (orphans.length > 0) {
        const host = windows.find((w) => w.key) ?? windows[0];
        host?.workspaces.push({
            id: "workspace:unmatched",
            name: "(unmatched panes)",
            panes: orphans,
        });
    }

    return windows;
}

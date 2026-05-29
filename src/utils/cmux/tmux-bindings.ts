import type { CmuxLayoutTree } from "@app/utils/cmux/types";

export interface CmuxTmuxSurfaceRef {
    workspaceId: string;
    surfaceId: string;
    title: string;
}

export function findCmuxSurfacesForTmuxSession(layout: CmuxLayoutTree, tmuxSessionName: string): CmuxTmuxSurfaceRef[] {
    const bindings: CmuxTmuxSurfaceRef[] = [];

    for (const window of layout.windows) {
        for (const workspace of window.workspaces) {
            for (const pane of workspace.panes) {
                for (const surface of pane.surfaces) {
                    if (surface.type !== "terminal") {
                        continue;
                    }

                    if (surface.title === tmuxSessionName) {
                        bindings.push({
                            workspaceId: workspace.id,
                            surfaceId: surface.id,
                            title: surface.title,
                        });
                    }
                }
            }
        }
    }

    return bindings;
}

export function indexCmuxSurfacesByTmuxSession(layout: CmuxLayoutTree): Map<string, CmuxTmuxSurfaceRef[]> {
    const map = new Map<string, CmuxTmuxSurfaceRef[]>();

    for (const window of layout.windows) {
        for (const workspace of window.workspaces) {
            for (const pane of workspace.panes) {
                for (const surface of pane.surfaces) {
                    if (surface.type !== "terminal" || !surface.title) {
                        continue;
                    }

                    const existing = map.get(surface.title) ?? [];
                    existing.push({
                        workspaceId: workspace.id,
                        surfaceId: surface.id,
                        title: surface.title,
                    });
                    map.set(surface.title, existing);
                }
            }
        }
    }

    return map;
}

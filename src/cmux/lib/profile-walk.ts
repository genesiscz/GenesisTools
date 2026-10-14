import type { Pane, Profile, Surface, TerminalSurface, Window, Workspace } from "@app/cmux/lib/types";

/** One surface of a profile with its containers and its place: the seven hand-nested walkers read these. */
export interface ProfileSurface {
    window: Window;
    workspace: Workspace;
    /** Counted across every window, in profile order. */
    workspaceIndex: number;
    pane: Pane;
    surface: Surface;
    /** The surface's position in its pane (its tab). */
    tabIndex: number;
    /** `window/workspace/pane/surface` indices, a stable key within one profile. */
    path: string;
}

/** Every surface of the profile, in profile order. */
export function profileSurfaces(profile: Profile): ProfileSurface[] {
    const out: ProfileSurface[] = [];
    let workspaceIndex = 0;

    profile.windows.forEach((window, w) => {
        window.workspaces.forEach((workspace, ws) => {
            workspace.panes.forEach((pane, p) => {
                pane.surfaces.forEach((surface, tabIndex) => {
                    out.push({
                        window,
                        workspace,
                        workspaceIndex,
                        pane,
                        surface,
                        tabIndex,
                        path: `${w}/${ws}/${p}/${tabIndex}`,
                    });
                });
            });
            workspaceIndex += 1;
        });
    });

    return out;
}

/** The profile with every terminal surface replaced by `map`'s answer; browsers and every container stay. */
export function mapTerminalSurfaces(
    profile: Profile,
    map: (surface: TerminalSurface, path: string) => Surface
): Profile {
    return {
        ...profile,
        windows: profile.windows.map((window, w) => ({
            ...window,
            workspaces: window.workspaces.map((workspace, ws) => ({
                ...workspace,
                panes: workspace.panes.map((pane, p) => ({
                    ...pane,
                    surfaces: pane.surfaces.map((surface, s) =>
                        surface.type === "terminal" ? map(surface, `${w}/${ws}/${p}/${s}`) : surface
                    ),
                })),
            })),
        })),
    };
}

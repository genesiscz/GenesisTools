export interface CmuxLayoutSurface {
    id: string;
    title: string;
    type: string;
    selected: boolean;
    preview?: string;
}

export interface CmuxLayoutPane {
    id: string;
    title: string;
    active: boolean;
    surfaces: CmuxLayoutSurface[];
}

export interface CmuxLayoutWorkspace {
    id: string;
    name: string;
    selected?: boolean;
    panes: CmuxLayoutPane[];
}

export interface CmuxLayoutWindow {
    id: string;
    index: number;
    visible: boolean;
    workspaces: CmuxLayoutWorkspace[];
}

export interface CmuxLayoutTree {
    fetchedAt: string;
    available: boolean;
    error?: string;
    windows: CmuxLayoutWindow[];
}

export type CmuxSendTarget =
    | { mode: "workspace_by_name"; workspaceName: string }
    | { mode: "new_split"; workspaceId: string }
    | { mode: "new_surface"; workspaceId: string; paneId: string }
    | { mode: "existing_surface"; workspaceId: string; surfaceId: string };

export type DashboardSendTarget = { mode: "quick_dev_dashboard" } | CmuxSendTarget;

export interface AttachTmuxResult {
    workspaceId: string;
    paneId: string;
    surfaceId: string;
    tmuxSessionName: string;
}

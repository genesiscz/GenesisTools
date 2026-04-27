export const PROFILE_VERSION = 1;

export type ProfileScope = "all" | "window" | "workspace";

export type CommandSource = "history" | "manual" | "none";

export interface PixelFrame {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ContainerFrame {
    width: number;
    height: number;
}

export interface TerminalSurface {
    type: "terminal";
    title: string;
    cwd?: string;
    command?: string;
    command_source?: CommandSource;
}

export interface BrowserSurface {
    type: "browser";
    title: string;
    url?: string;
}

export type Surface = TerminalSurface | BrowserSurface;

export interface Pane {
    ref: string;
    index: number;
    columns: number;
    rows: number;
    pixel_frame: PixelFrame;
    selected_surface_index: number;
    surfaces: Surface[];
}

export interface Workspace {
    ref: string;
    title: string;
    selected: boolean;
    current_directory?: string;
    panes: Pane[];
}

export interface Window {
    ref: string;
    title: string;
    container_frame: ContainerFrame;
    workspaces: Workspace[];
}

export interface Profile {
    version: typeof PROFILE_VERSION;
    name: string;
    scope: ProfileScope;
    captured_at: string;
    cmux_version: string;
    note?: string;
    windows: Window[];
}

export interface ProfileSummary {
    name: string;
    captured_at: string;
    scope: ProfileScope;
    note?: string;
    cmux_version: string;
    windows: number;
    workspaces: number;
    panes: number;
    surfaces: number;
    bytes: number;
    path: string;
}

import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";

export const PROFILE_VERSION = 1;

export type ProfileScope = "all" | "window" | "workspace";

export type CommandSource = "scrollback" | "foreground" | "offline" | "shell-journal" | "manual" | "inferred" | "none";

export interface ScreenSnapshot {
    /** Raw rendered text returned by `cmux capture-pane` at save time. ANSI-stripped. */
    text: string;
    /** Number of rendered rows captured (for display in `view`). */
    rows: number;
}

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
    /**
     * The cmux surface UUID at capture time. cmux keeps it across a relaunch while the `surface:N` refs
     * renumber, so `--in-place` pairs a captured tab with the live one by this id.
     */
    surface_id?: string;
    cwd?: string;
    /**
     * Visible terminal content captured at save time. On restore the new pane is
     * cleared and this text is printed back so the pane looks exactly like it did
     * when saved (login banner, previous prompts, last command, etc.).
     */
    screen?: ScreenSnapshot;
    /**
     * Most recent shell-prompt+command line found in scrollback at save time. On restore
     * this is *typed but not executed* at the new prompt (no trailing newline) so the
     * user can review and press Enter — useful for re-launching TUIs like
     * `claude --resume <id>` that don't show up cleanly in screen replay.
     */
    command?: string;
    command_source?: CommandSource;
    /** Exact native autosave binding; survives title-based inference on later restores. */
    resume?: { kind: AccountProviderAlias; sessionId: string };
    /**
     * The command as originally captured, before any enrichment (account added,
     * `-- --resume <sessionId>` appended). Present only when `command` differs.
     */
    command_original?: string;
    /**
     * Human-readable notes for every difference between command_original and command.
     * Restore prints these as a per-pane drift diff and never hides them.
     */
    drift?: string[];
    /**
     * What picked the session the command resumes: the tab's own surface journal, the tab title in the tab's
     * directory, or weaker evidence (first-prompt words, a title in another directory). `--in-place` does
     * not type a `weak` pick by itself.
     */
    resume_evidence?: ResumeEvidence;
}

export type ResumeEvidence = "journal" | "title" | "weak";

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

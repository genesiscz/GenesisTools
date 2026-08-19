import type { LayoutMode, RestorePlan } from "@app/claude/lib/cmux/types";

/**
 * Everything the restore can be told to do, in one object.
 *
 * The flags set it once; the confirmation menu then edits it in place, so every
 * capability the CLI has is reachable without knowing a flag name.
 */
export interface RestoreSettings {
    layout: LayoutMode;
    perWorkspace: number;
    perProject: boolean;
    newWindow: boolean;
    /** Run each pane's command, or leave it typed at the prompt. */
    enter: boolean;
    /** Let panes with no recorded account pick the best one instead of asking. */
    autopick: boolean;
    /** Force every pane onto this account, whatever the pins say. */
    forceAccount?: string;
}

export type TuneAction =
    | "go"
    | "layout"
    | "per-workspace"
    | "grouping"
    | "window"
    | "launch"
    | "accounts"
    | "sessions"
    | "cancel";

export interface TuneOption {
    value: TuneAction;
    label: string;
    hint?: string;
}

/** `capped (4 per workspace)` — the layout plus the number that qualifies it. */
export function describeLayout(settings: RestoreSettings): string {
    if (settings.layout === "grid") {
        return "grid (one workspace, every session a pane)";
    }

    const shape = settings.layout === "capped" ? "grid, overflow into more workspaces" : "grid, overflow as tabs";

    return `${settings.layout} (${settings.perWorkspace} panes per workspace, ${shape})`;
}

export function describeAccounts(settings: RestoreSettings): string {
    if (settings.forceAccount) {
        return `every pane as ${settings.forceAccount}`;
    }

    return settings.autopick ? "pins, then auto-pick the rest" : "pins, ask for the rest";
}

/**
 * The confirmation menu.
 *
 * It replaces a yes/no because the answer to "restore these?" is often "yes, but as one
 * workspace" or "yes, without running them". Each row shows the CURRENT value, so the
 * menu doubles as the summary of what is about to happen.
 */
export function tuneOptions(settings: RestoreSettings, plan: RestorePlan, sessionCount: number): TuneOption[] {
    const workspaces = plan.workspaces.length;
    const panes = plan.workspaces.reduce((n, w) => n + w.panes.length, 0);
    const options: TuneOption[] = [
        {
            value: "go",
            label: "Restore now",
            hint: `${sessionCount} session${sessionCount === 1 ? "" : "s"} · ${panes} pane${panes === 1 ? "" : "s"} · ${workspaces} workspace${workspaces === 1 ? "" : "s"}`,
        },
        { value: "layout", label: "Layout", hint: describeLayout(settings) },
    ];

    // A cap only means something to the layouts that overflow.
    if (settings.layout !== "grid") {
        options.push({
            value: "per-workspace",
            label: "Panes per workspace",
            hint: String(settings.perWorkspace),
        });
    }

    options.push(
        {
            value: "grouping",
            label: "Grouping",
            hint: settings.perProject ? "one workspace set per project" : "all projects in one set",
        },
        { value: "window", label: "Window", hint: settings.newWindow ? "a new cmux window" : "this window" },
        {
            value: "launch",
            label: "On launch",
            hint: settings.enter ? "run the command" : "queue it at the prompt",
        },
        { value: "accounts", label: "Accounts", hint: describeAccounts(settings) },
        { value: "sessions", label: "Pick sessions again", hint: `${sessionCount} selected` },
        { value: "cancel", label: "Cancel", hint: "nothing is restored" }
    );

    return options;
}

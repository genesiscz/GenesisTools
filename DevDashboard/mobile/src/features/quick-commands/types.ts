import type { DashboardSendTarget, SavedCommand, SavedCommandInput } from "@dd/contract";

export type { DashboardSendTarget, SavedCommand, SavedCommandInput };

/** A flattened picker row: a human label + the resolved send target it maps to. */
export interface RunTargetOption {
    /** Stable id for the testID `target-pick-<id>` (e.g. a tmux session name or "quick"). */
    id: string;
    label: string;
    target: DashboardSendTarget;
}

/** What `useRunCommand` needs: the snippet to run + where to run it. */
export interface RunCommandInput {
    command: SavedCommand;
    target: DashboardSendTarget;
}

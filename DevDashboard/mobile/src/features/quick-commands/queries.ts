import type { CommandsRes, DashboardClient, SavedCommand } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";
import type { RunCommandInput } from "@/features/quick-commands/types";

/**
 * Quick Commands data layer (same per-feature shape as terminals/pulse). Owns its co-located keys
 * and a `queryOptions` FACTORY for the one read endpoint, plus thin client callers for the mutations.
 * `runCommand` is the composition: it does NOT hit a new exec endpoint — it spawns a tmux session
 * that runs the snippet (`tmux.create`), then attaches that session to the picked cmux target
 * (`cmux.sendSession`). No shell string ever leaves this layer except as the snippet `command`.
 */
export const quickCommandsKeys = {
    list: ["commands", "list"] as const,
} as const;

export const COMMANDS_INTERVAL_MS = 10_000;

export function commandsListQuery(client: DashboardClient) {
    return queryOptions<CommandsRes>({
        queryKey: quickCommandsKeys.list,
        queryFn: () => client.commands.list(),
        refetchInterval: COMMANDS_INTERVAL_MS,
    });
}

export function createCommand(client: DashboardClient, input: { label: string; command: string }) {
    return client.commands.create(input);
}

export function deleteCommand(client: DashboardClient, id: string) {
    return client.commands.delete(id);
}

/** Compose the two existing exec primitives: create-a-tmux-running-the-snippet, then attach it. */
export async function runCommand(client: DashboardClient, input: RunCommandInput) {
    const created = await client.tmux.create({ command: input.command.command });
    return client.cmux.sendSession({
        tmuxSessionName: created.sessionName,
        target: input.target,
    });
}

export type { SavedCommand };

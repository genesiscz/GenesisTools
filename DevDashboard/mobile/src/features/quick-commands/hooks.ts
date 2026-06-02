import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import {
    commandsListQuery,
    createCommand,
    deleteCommand,
    quickCommandsKeys,
    runCommand,
} from "@/features/quick-commands/queries";
import type { RunCommandInput } from "@/features/quick-commands/types";

export function useCommands() {
    return useQuery(commandsListQuery(useDashboardClient()));
}

function useInvalidateCommands() {
    const qc = useQueryClient();

    return () => {
        void qc.invalidateQueries({ queryKey: quickCommandsKeys.list });
    };
}

export function useCreateCommand() {
    const client = useDashboardClient();
    const invalidate = useInvalidateCommands();

    return useMutation({
        mutationFn: (input: { label: string; command: string }) => createCommand(client, input),
        onSuccess: invalidate,
    });
}

export function useDeleteCommand() {
    const client = useDashboardClient();
    const invalidate = useInvalidateCommands();

    return useMutation({
        mutationFn: (id: string) => deleteCommand(client, id),
        onSuccess: invalidate,
    });
}

export function useRunCommand() {
    const client = useDashboardClient();

    return useMutation({
        mutationFn: (input: RunCommandInput) => runCommand(client, input),
    });
}

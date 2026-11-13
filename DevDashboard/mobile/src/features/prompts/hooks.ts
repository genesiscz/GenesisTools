import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { prepareQuery, promptsQuery } from "@/features/prompts/queries";

/** Component-facing saved-prompt hooks (D32): the Mac's prompt list, and one prompt prepared for a session. */
export function usePromptList() {
    return useQuery(promptsQuery(useDashboardClient()));
}

export function usePreparedPrompt(input: { name: string; session: string | null; vars: Record<string, string> }) {
    return useQuery(prepareQuery(useDashboardClient(), input));
}

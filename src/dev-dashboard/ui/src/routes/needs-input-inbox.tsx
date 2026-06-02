import type { AttentionRes } from "@app/dev-dashboard/contract/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AttentionList } from "@/components/needs-input-inbox/AttentionList";
import { attentionApi } from "@/lib/api";

/**
 * Needs-Input Inbox web route — the curated "what needs me right now" queue. Consumes the SAME
 * `/api/attention` backend route as the mobile screen: the server joins today's unread `action` QA
 * entries with live agent ttyd sessions. Opening an agent session jumps to `/ttyd?tab=<id>`; resolving
 * a question marks it read (reuses `/api/qa/read`) and the item drops out on the next refetch.
 */
export function NeedsInputInboxRoute() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [resolvingId, setResolvingId] = useState<string | null>(null);

    const { data, isPending, isError, error } = useQuery<AttentionRes>({
        queryKey: ["attention"],
        queryFn: attentionApi.list,
        refetchInterval: 15_000,
    });

    const resolveMutation = useMutation({
        mutationFn: (qaId: string) => attentionApi.read([qaId]),
        onMutate: (qaId) => setResolvingId(qaId),
        onSettled: () => {
            setResolvingId(null);
            queryClient.invalidateQueries({ queryKey: ["attention"] });
        },
    });

    const onOpenTerminal = (ttydTabId: string) => {
        navigate({ to: "/ttyd", search: { tab: ttydTabId } });
    };

    if (isError) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center">
                <p className="text-lg font-bold text-[#f87171]">Inbox unavailable</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">
                    {error instanceof Error ? error.message : "Could not reach the agent."}
                </p>
            </div>
        );
    }

    if (isPending) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]">
                Loading inbox...
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <AttentionList
                items={data.items}
                onOpenTerminal={onOpenTerminal}
                onResolve={(qaId) => resolveMutation.mutate(qaId)}
                resolvingId={resolvingId}
            />
        </div>
    );
}

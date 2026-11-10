import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import type {
    HandoffActionInput,
    HandoffGetResponse,
    HandoffTarget,
    HandoffTaskInput,
    PublicHandoff,
} from "@app/dev-dashboard/lib/handoff-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboard, withServerMessage } from "@/lib/dashboard-client";

export function useHandoffList() {
    return useQuery({
        queryKey: ["handoff-log"],
        queryFn: () => withServerMessage(dashboard.call(ENDPOINTS.handoffLog, { limit: 200 })),
        retry: false,
    });
}

export function useHandoffDetail(id: string | null) {
    return useQuery({
        queryKey: ["handoff", id],
        enabled: id !== null,
        queryFn: () => withServerMessage(dashboard.call(ENDPOINTS.handoffGet, { id: id ?? "" })),
        retry: false,
    });
}

/**
 * All mutations go through the one action language (§7.2). No optimistic
 * updates — the POST response's folded handoff is authoritative (§7.3).
 */
export function useHandoffAction(id: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (actions: HandoffActionInput[]) =>
            withServerMessage(dashboard.call(ENDPOINTS.handoffAction, { id, actions })),
        onSuccess: (res) => {
            queryClient.setQueryData<HandoffGetResponse>(["handoff", id], (prev) => ({
                editId: prev?.editId,
                handoff: res.handoff,
                info: res.info,
            }));
            void queryClient.invalidateQueries({ queryKey: ["handoff-log"] });
        },
    });
}

export function useHandoffCreate() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: {
            title: string;
            name?: string;
            description?: string;
            tasks: HandoffTaskInput[];
            target?: HandoffTarget;
            refs?: string[];
        }) => withServerMessage(dashboard.call(ENDPOINTS.handoffPost, input)),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["handoff-log"] });
        },
    });
}

export async function uploadHandoffAttachment(input: {
    id: string;
    file: File;
    taskId?: string;
}): Promise<{ attachmentId: string; handoff: PublicHandoff }> {
    return withServerMessage(
        dashboard.call(
            ENDPOINTS.handoffAttach,
            { id: input.id, filename: input.file.name || "pasted.png", taskId: input.taskId },
            { rawBody: { data: input.file, contentType: input.file.type || "application/octet-stream" } }
        )
    );
}

export function attachmentUrl(attachmentId: string): string {
    return dashboard.url(ENDPOINTS.handoffAttachment, { id: attachmentId });
}

import type {
    HandoffActionInput,
    HandoffActionResponse,
    HandoffGetResponse,
    HandoffListResponse,
    HandoffPostResponse,
    HandoffTarget,
    HandoffTaskInput,
    PublicHandoff,
} from "@app/dev-dashboard/lib/handoff-types";
import { SafeJSON } from "@genesiscz/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const text = await res.text();

    if (!res.ok) {
        let message = text;

        try {
            const body = SafeJSON.parse(text, { strict: true }) as { error?: string };

            if (typeof body.error === "string") {
                message = body.error;
            }
        } catch {
            /* non-JSON error body — use raw text */
        }

        throw new Error(message || `${res.status}`);
    }

    return SafeJSON.parse(text, { strict: true }) as T;
}

export function useHandoffList() {
    return useQuery({
        queryKey: ["handoff-log"],
        queryFn: () => fetchJson<HandoffListResponse>("/api/handoff/log?limit=200"),
        retry: false,
    });
}

export function useHandoffDetail(id: string | null) {
    return useQuery({
        queryKey: ["handoff", id],
        enabled: id !== null,
        queryFn: () => fetchJson<HandoffGetResponse>(`/api/handoff/get?id=${encodeURIComponent(id ?? "")}`),
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
            fetchJson<HandoffActionResponse>("/api/handoff/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ id, actions }, { strict: true }),
            }),
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
            description?: string;
            tasks: HandoffTaskInput[];
            target?: HandoffTarget;
            refs?: string[];
        }) =>
            fetchJson<HandoffPostResponse>("/api/handoff/post", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(input, { strict: true }),
            }),
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
    const params = new URLSearchParams({ id: input.id, filename: input.file.name || "pasted.png" });

    if (input.taskId !== undefined) {
        params.set("taskId", input.taskId);
    }

    const res = await fetch(`/api/handoff/attach?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": input.file.type || "application/octet-stream" },
        body: input.file,
    });
    const text = await res.text();

    if (!res.ok) {
        let message = text;

        try {
            const body = SafeJSON.parse(text, { strict: true }) as { error?: string };

            if (typeof body.error === "string") {
                message = body.error;
            }
        } catch {
            /* raw text */
        }

        throw new Error(message || `${res.status}`);
    }

    return SafeJSON.parse(text, { strict: true }) as { attachmentId: string; handoff: PublicHandoff };
}

export function attachmentUrl(attachmentId: string): string {
    return `/api/handoff/attachment?id=${encodeURIComponent(attachmentId)}`;
}

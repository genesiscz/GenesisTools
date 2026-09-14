import type { AskForm } from "@app/question/lib/pending/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useQaStream } from "@/hooks/useQaStream";
import { qaPendingApi } from "@/lib/api";

/**
 * Merge a REST snapshot with the live SSE lifecycle so the section is right both on first
 * paint and afterwards.
 *
 * The map is keyed by form id and the SSE frame always wins, because it carries the newest
 * status. A form that leaves `pending` is dropped here — the answered copy reappears in the
 * history list as a normal QaEntry, so it never shows twice.
 */
export function usePendingForms(): { forms: AskForm[]; isLoading: boolean; refetch: () => void } {
    const [byId, setById] = useState<Map<string, AskForm>>(() => new Map());
    const query = useQuery({
        queryKey: ["qa-pending"],
        queryFn: () => qaPendingApi.list().then((r) => r.forms),
        retry: false,
        staleTime: 10_000,
    });

    useEffect(() => {
        if (!query.data) {
            return;
        }

        setById((prev) => {
            const next = new Map(prev);

            for (const form of query.data) {
                // A snapshot row must never resurrect a form the stream already resolved.
                if (!next.has(form.id)) {
                    next.set(form.id, form);
                }
            }

            return next;
        });
    }, [query.data]);

    useQaStream(
        useCallback((frame) => {
            if (frame.type !== "pending") {
                return;
            }

            setById((prev) => {
                const next = new Map(prev);

                if (frame.form.status === "pending") {
                    next.set(frame.id, frame.form);
                } else {
                    next.delete(frame.id);
                }

                return next;
            });
        }, [])
    );

    const forms = [...byId.values()]
        .filter((form) => form.status === "pending")
        .sort((a, b) => b.createdAt - a.createdAt);

    return { forms, isLoading: query.isLoading, refetch: () => void query.refetch() };
}

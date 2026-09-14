import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
    GlassDialogBody,
    GlassDialogContent,
    GlassDialogDescription,
    GlassDialogEyebrow,
    GlassDialogFooter,
    GlassDialogHeader,
    GlassDialogScroll,
    GlassDialogShell,
    GlassDialogTitle,
} from "@ui/components/glass-dialog";
import { useEffect, useState } from "react";
import { cmuxApi } from "@/lib/api";

interface PaneChoice {
    workspaceId: string;
    workspaceName: string;
    paneId: string;
    title: string;
    active: boolean;
}

/**
 * Pick a cmux pane to raise for a session.
 *
 * Deliberately reads the existing `/api/cmux/snapshot` and posts the existing
 * `/api/cmux/attach`; there is no second tree protocol for the QA page.
 */
export function QaCmuxPickerDialog({
    open,
    onOpenChange,
    sessionId,
}: {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    sessionId: string;
}) {
    const [error, setError] = useState<string | null>(null);

    // The dialog stays mounted when it closes, so without this a failure from one attempt was
    // still on screen the next time it opened.
    useEffect(() => {
        if (open) {
            setError(null);
        }
    }, [open]);

    const snapshotQuery = useQuery({
        queryKey: ["cmux", "snapshot"],
        queryFn: () => cmuxApi.snapshot().then((r) => r.snapshot),
        enabled: open,
        staleTime: 5_000,
        retry: false,
    });

    const attach = useMutation({
        mutationFn: (choice: PaneChoice) => cmuxApi.attach({ workspaceId: choice.workspaceId, paneId: choice.paneId }),
        onSuccess: () => {
            setError(null);
            onOpenChange(false);
        },
        onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });

    const snapshot = snapshotQuery.data;
    const workspaceNameById = new Map((snapshot?.workspaces ?? []).map((ws) => [ws.id, ws.name]));
    const choices: PaneChoice[] = (snapshot?.panes ?? []).map((pane) => ({
        workspaceId: pane.workspaceId,
        workspaceName: workspaceNameById.get(pane.workspaceId) ?? pane.workspaceId,
        paneId: pane.id,
        title: pane.title,
        active: pane.active,
    }));

    return (
        <GlassDialogShell open={open} onOpenChange={onOpenChange}>
            <GlassDialogContent className="sm:max-w-lg">
                <GlassDialogHeader>
                    <GlassDialogEyebrow>cmux</GlassDialogEyebrow>
                    <GlassDialogTitle>Open a pane</GlassDialogTitle>
                    <GlassDialogDescription>
                        Raise a cmux pane for session {sessionId.slice(0, 8)}. Focus already picks the best match; use
                        this when you want a different pane.
                    </GlassDialogDescription>
                </GlassDialogHeader>
                <GlassDialogBody>
                    <GlassDialogScroll className="max-h-80">
                        {snapshotQuery.isLoading ? (
                            <p className="py-6 text-center text-sm text-[var(--dd-text-muted)]">Loading panes…</p>
                        ) : snapshotQuery.isError ? (
                            // `retry: false`, so a failed snapshot leaves `data` undefined and an
                            // empty pane list. Reporting "no open pane" there names the wrong cause.
                            <p className="py-6 text-center text-sm text-[var(--dd-danger)]">
                                cmux is not reachable, so its panes could not be listed.
                            </p>
                        ) : choices.length === 0 ? (
                            <p className="py-6 text-center text-sm text-[var(--dd-text-muted)]">
                                cmux reports no open pane.
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {choices.map((choice) => (
                                    <li key={`${choice.workspaceId}:${choice.paneId}`}>
                                        <button
                                            type="button"
                                            // A second click while the first is in flight posts
                                            // another attach, and the route re-runs the whole
                                            // workspace-select and pane-focus dance.
                                            disabled={attach.isPending}
                                            className="w-full cursor-pointer rounded border border-[var(--dd-border)] px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--dd-border)]/40 disabled:cursor-not-allowed disabled:opacity-50"
                                            onClick={() => attach.mutate(choice)}
                                        >
                                            <span className="text-[var(--dd-text-primary)]">
                                                {choice.workspaceName}
                                            </span>
                                            <span className="text-[var(--dd-text-muted)]"> · {choice.paneId}</span>
                                            {choice.active ? <span className="dd-accent-text"> · active</span> : null}
                                            <span className="block truncate font-mono text-[10px] text-[var(--dd-text-muted)]">
                                                {choice.title}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </GlassDialogScroll>
                    {error ? <p className="pt-2 text-xs text-[var(--dd-danger)]">{error}</p> : null}
                </GlassDialogBody>
                <GlassDialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </GlassDialogFooter>
            </GlassDialogContent>
        </GlassDialogShell>
    );
}

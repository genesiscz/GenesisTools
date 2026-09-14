import {
    resumeCommandFor,
    type SessionActionState,
    sessionActionStates,
    sessionActionsNotice,
} from "@app/dev-dashboard/lib/qa-session-actions";
import { useQuery } from "@tanstack/react-query";
import { IconButton } from "@ui/components/icon-button";
import { Crosshair, Hash, PanelsTopLeft, TerminalSquare } from "lucide-react";
import { type ReactNode, useState } from "react";
import { QaCmuxPickerDialog } from "@/components/QaCmuxPickerDialog";
import { cmuxApi } from "@/lib/api";

const ACTION_BUTTON_CLASS = "size-6 text-inherit hover:bg-[var(--dd-border)]/50 hover:text-[var(--dd-text-secondary)]";

/**
 * One verb in the row.
 *
 * A blocked verb uses `aria-disabled` rather than `disabled`: a natively disabled button
 * swallows pointer events, and the tooltip carrying the reason would never open — which is
 * the whole point of disabling it visibly.
 */
function ActionButton({
    state,
    label,
    onClick,
    children,
}: {
    state: SessionActionState;
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <IconButton
            variant="ghost"
            size="icon-sm"
            className={`${ACTION_BUTTON_CLASS}${state.enabled ? "" : " cursor-not-allowed opacity-40"}`}
            tooltip={state.enabled ? label : `${label} — ${state.reason}`}
            aria-disabled={state.enabled ? undefined : true}
            onClick={() => {
                if (!state.enabled) {
                    return;
                }

                onClick();
            }}
        >
            {children}
        </IconButton>
    );
}

/**
 * Focus / Cmux / Copy id / Copy resume for the session that produced one Q→A or pending form.
 *
 * Mirrors the Genesis usage-monitor action row so both surfaces offer the same four verbs
 * and the same resume string. Shown on history cards and pending cards alike.
 */
export function QaSessionActions({ sessionId }: { sessionId: string | null | undefined }) {
    const [copied, setCopied] = useState<"id" | "resume" | "error" | null>(null);
    const [focusError, setFocusError] = useState<string | null>(null);
    const [focusing, setFocusing] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    // Shared with every other card and with the cmux page: one poll, not one per card.
    const snapshotQuery = useQuery({
        queryKey: ["cmux", "snapshot"],
        queryFn: () => cmuxApi.snapshot().then((r) => r.snapshot),
        staleTime: 15_000,
        retry: false,
    });
    const snapshot = snapshotQuery.data;
    const states = sessionActionStates({
        sessionId,
        cmuxUnavailable: snapshotQuery.isError || (snapshot ? !snapshot.available : false),
        cmuxPaneCount: snapshot?.panes.length,
    });
    const notice = sessionActionsNotice(states);
    const id = sessionId ?? "";

    const copy = async (kind: "id" | "resume"): Promise<void> => {
        try {
            await navigator.clipboard.writeText(kind === "id" ? id : resumeCommandFor(id));
            setCopied(kind);
        } catch {
            // navigator.clipboard rejects on permission denial or an insecure context.
            setCopied("error");
        }

        setTimeout(() => setCopied(null), 1200);
    };

    const focus = async (): Promise<void> => {
        setFocusing(true);
        setFocusError(null);

        try {
            const result = await cmuxApi.focusSession(id);

            if (!result.ok) {
                setFocusError(`${result.error} ${result.remedy}`);
            }
        } finally {
            setFocusing(false);
        }
    };

    return (
        <>
            <div className="inline-flex shrink-0 items-center gap-0.5 text-[var(--dd-text-muted)]">
                <ActionButton state={states.focus} label="Focus the cmux pane" onClick={() => void focus()}>
                    <Crosshair className={`h-3.5 w-3.5${focusing ? " animate-pulse" : ""}`} />
                </ActionButton>
                <ActionButton state={states.cmux} label="Open in cmux…" onClick={() => setPickerOpen(true)}>
                    <PanelsTopLeft className="h-3.5 w-3.5" />
                </ActionButton>
                <ActionButton state={states.copyId} label="Copy session id" onClick={() => void copy("id")}>
                    {copied === "id" ? <span className="text-xs">✓</span> : <Hash className="h-3.5 w-3.5" />}
                </ActionButton>
                <ActionButton state={states.copyResume} label="Copy resume command" onClick={() => void copy("resume")}>
                    {copied === "resume" ? (
                        <span className="text-xs">✓</span>
                    ) : (
                        <TerminalSquare className="h-3.5 w-3.5" />
                    )}
                </ActionButton>
                {copied === "error" ? <span className="text-xs text-[var(--dd-danger)]">clipboard blocked</span> : null}
            </div>
            {focusError ? (
                <span className="basis-full text-[10px] text-[var(--dd-danger)]" data-testid="qa-focus-error">
                    {focusError}
                </span>
            ) : notice ? (
                <span className="basis-full text-[10px] text-[var(--dd-text-muted)]" data-testid="qa-session-notice">
                    {notice}
                </span>
            ) : null}
            <QaCmuxPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} sessionId={id} />
        </>
    );
}

import type { LogSourceId } from "@app/utils/log-viewer/log-source";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { createContext, type ReactElement, type ReactNode, useCallback, useContext, useState } from "react";

export interface SessionDeleteRequest {
    source: LogSourceId;
    name: string;
    badge?: string;
    onConfirmed?: () => void;
    onAfterDelete?: () => void;
}

interface SessionDeleteConfirmContextValue {
    requestDelete: (request: SessionDeleteRequest) => void;
}

const SessionDeleteConfirmContext = createContext<SessionDeleteConfirmContextValue | null>(null);

interface ProviderProps {
    children: ReactNode;
    onDeleteSession: (source: LogSourceId, name: string) => Promise<void>;
}

export function SessionDeleteConfirmProvider({ children, onDeleteSession }: ProviderProps): ReactElement {
    const [pending, setPending] = useState<SessionDeleteRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const confirmButtonId = "dbg-session-delete-confirm";

    const requestDelete = useCallback((request: SessionDeleteRequest) => {
        setPending(request);
    }, []);

    const close = useCallback(() => {
        if (busy) {
            return;
        }

        setPending(null);
    }, [busy]);

    const confirm = useCallback(async () => {
        if (!pending || busy) {
            return;
        }

        setBusy(true);

        try {
            pending.onConfirmed?.();
            await onDeleteSession(pending.source, pending.name);
            pending.onAfterDelete?.();
            setPending(null);
        } finally {
            setBusy(false);
        }
    }, [busy, onDeleteSession, pending]);

    const badgeLabel = pending?.badge ?? pending?.source ?? "session";

    return (
        <SessionDeleteConfirmContext.Provider value={{ requestDelete }}>
            {children}
            <AlertDialog
                open={pending !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        close();
                    }
                }}
            >
                <AlertDialogContent
                    className="border-white/10 bg-[#0d0d18] text-white/90 sm:max-w-md"
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        document.getElementById(confirmButtonId)?.focus();
                    }}
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle className="font-mono uppercase tracking-wider text-white/95">
                            Delete session?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="font-mono text-sm text-white/55">
                            Permanently delete{" "}
                            <span className="text-cyan-300/90">
                                [{badgeLabel}] {pending?.name}
                            </span>{" "}
                            and all log files on disk. This cannot be undone. Press{" "}
                            <span className="text-white/70">Enter</span> to confirm.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel
                            disabled={busy}
                            className="font-mono uppercase tracking-wider border-white/15 bg-transparent text-white/70 hover:bg-white/5 hover:text-white/90"
                        >
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            id={confirmButtonId}
                            disabled={busy}
                            className="font-mono uppercase tracking-wider border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 focus-visible:ring-rose-500/40"
                            onClick={(event) => {
                                event.preventDefault();
                                void confirm();
                            }}
                        >
                            {busy ? "Deleting…" : "Delete"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </SessionDeleteConfirmContext.Provider>
    );
}

export function useSessionDeleteConfirm(): SessionDeleteConfirmContextValue {
    const ctx = useContext(SessionDeleteConfirmContext);

    if (!ctx) {
        throw new Error("useSessionDeleteConfirm must be used within SessionDeleteConfirmProvider");
    }

    return ctx;
}

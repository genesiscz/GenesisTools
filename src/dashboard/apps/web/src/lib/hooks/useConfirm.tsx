import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { createContext, useCallback, useContext, useRef, useState } from "react";

interface ConfirmOptions {
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based confirm backed by the themed Dialog. Replaces blocking,
 * unstyled, SSR-unsafe `window.confirm()` for destructive actions.
 *
 * Usage: `const confirm = useConfirm(); if (await confirm({ title, destructive: true })) { ... }`
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const [opts, setOpts] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((value: boolean) => void) | null>(null);

    const confirm = useCallback<ConfirmFn>((options) => {
        setOpts(options);
        setOpen(true);
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
        });
    }, []);

    const settle = useCallback((value: boolean) => {
        setOpen(false);
        resolverRef.current?.(value);
        resolverRef.current = null;
    }, []);

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <Dialog
                open={open}
                onOpenChange={(next) => {
                    if (!next) {
                        settle(false);
                    }
                }}
            >
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle>{opts?.title}</DialogTitle>
                        {opts?.description && <DialogDescription>{opts.description}</DialogDescription>}
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => settle(false)}>
                            {opts?.cancelText ?? "Cancel"}
                        </Button>
                        <Button variant={opts?.destructive ? "destructive" : "brand"} onClick={() => settle(true)}>
                            {opts?.confirmText ?? "Confirm"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </ConfirmContext.Provider>
    );
}

export function useConfirm(): ConfirmFn {
    const ctx = useContext(ConfirmContext);
    if (!ctx) {
        throw new Error("useConfirm must be used within <ConfirmProvider>");
    }

    return ctx;
}

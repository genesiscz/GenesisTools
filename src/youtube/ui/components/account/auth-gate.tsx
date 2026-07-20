import { AuthDialog } from "@app/yt/components/account/auth-dialog";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

interface AuthGateValue {
    requireLogin: (retry?: () => void) => void;
    openAuth: (mode?: "login" | "register") => void;
}

const AuthGateContext = createContext<AuthGateValue | null>(null);

export function AuthGateProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"login" | "register">("login");
    const retryRef = useRef<(() => void) | null>(null);

    const openAuth = useCallback((nextMode: "login" | "register" = "login") => {
        setMode(nextMode);
        setOpen(true);
    }, []);

    const requireLogin = useCallback(
        (retry?: () => void) => {
            retryRef.current = retry ?? null;
            openAuth("login");
        },
        [openAuth]
    );

    const value = useMemo(() => ({ requireLogin, openAuth }), [requireLogin, openAuth]);

    return (
        <AuthGateContext.Provider value={value}>
            {children}
            <AuthDialog
                open={open}
                initialMode={mode}
                onOpenChange={(next) => {
                    setOpen(next);

                    if (!next) {
                        retryRef.current = null;
                    }
                }}
                onSuccess={() => {
                    const retry = retryRef.current;
                    retryRef.current = null;
                    setOpen(false);
                    retry?.();
                }}
            />
        </AuthGateContext.Provider>
    );
}

export function useAuthGate(): AuthGateValue {
    const ctx = useContext(AuthGateContext);

    if (!ctx) {
        throw new Error("useAuthGate must be used within AuthGateProvider");
    }

    return ctx;
}

/** Soft access — returns null outside the provider (e.g. first-run). */
export function useOptionalAuthGate(): AuthGateValue | null {
    return useContext(AuthGateContext);
}

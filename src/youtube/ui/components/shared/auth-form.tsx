import { logger } from "@genesiscz/utils/logger/client";
import { Button } from "@genesiscz/utils/ui/components/button";
import { Input } from "@genesiscz/utils/ui/components/input";
import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";

export type AuthMode = "login" | "register";

export interface AuthFormLabels {
    logIn: string;
    register: string;
    createAccount: string;
    email: string;
    password: string;
    emailPlaceholder: string;
    passwordLoginPlaceholder: string;
    passwordRegisterPlaceholder: string;
    signingIn: string;
    creatingAccount: string;
    registerHint: string;
}

const DEFAULT_LABELS: AuthFormLabels = {
    logIn: "Log in",
    register: "Register",
    createAccount: "Create account",
    email: "Email",
    password: "Password",
    emailPlaceholder: "you@example.com",
    passwordLoginPlaceholder: "Your password",
    passwordRegisterPlaceholder: "At least 8 characters",
    signingIn: "Signing in…",
    creatingAccount: "Creating account…",
    registerHint: "New accounts start with 💎 100.",
};

export interface AuthFormProps {
    onLogin: (creds: { email: string; password: string }) => Promise<void>;
    onRegister: (creds: { email: string; password: string }) => Promise<void>;
    /** When true, both submit buttons stay disabled (parent-owned pending). */
    busy?: boolean;
    labels?: Partial<AuthFormLabels>;
    /** Prefix for input ids so multiple forms on a page don't collide. */
    idPrefix?: string;
    className?: string;
    initialMode?: AuthMode;
    onSuccess?: () => void;
}

/**
 * Shared email/password login+register form used by the YouTube web UI and
 * the Chrome extension settings dialog. Callers own the API mutations so this
 * stays free of extension vs web hook differences.
 */
export function AuthForm({
    onLogin,
    onRegister,
    busy: busyProp = false,
    labels: labelsProp,
    idPrefix = "yt-auth",
    className,
    initialMode = "login",
    onSuccess,
}: AuthFormProps) {
    const [mode, setMode] = useState<AuthMode>(initialMode);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const labels = { ...DEFAULT_LABELS, ...labelsProp };
    const busy = busyProp || submitting;

    function switchMode(next: AuthMode) {
        setMode(next);
        setError(null);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();

        if (busy) {
            return;
        }

        setError(null);
        setSubmitting(true);

        try {
            const action = mode === "login" ? onLogin : onRegister;
            await action({ email, password });
            setPassword("");
            onSuccess?.();
        } catch (err) {
            logger.warn({ error: err, mode }, "auth-form: submit failed");
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    }

    const toggleBase = "h-7 flex-1 rounded-md text-xs font-medium transition-colors";
    const toggleActive = "bg-primary/20 text-foreground";
    const toggleIdle = "text-muted-foreground hover:text-foreground";
    const emailId = `${idPrefix}-email`;
    const passwordId = `${idPrefix}-password`;

    return (
        <form className={className ? `space-y-3 ${className}` : "space-y-3"} onSubmit={submit}>
            <div className="flex gap-1 rounded-lg border border-primary/15 bg-black/20 p-1" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "login"}
                    className={`${toggleBase} ${mode === "login" ? toggleActive : toggleIdle}`}
                    onClick={() => switchMode("login")}
                >
                    {labels.logIn}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "register"}
                    className={`${toggleBase} ${mode === "register" ? toggleActive : toggleIdle}`}
                    onClick={() => switchMode("register")}
                >
                    {labels.register}
                </button>
            </div>

            <div className="space-y-1">
                <label htmlFor={emailId} className="text-xs font-medium text-muted-foreground">
                    {labels.email}
                </label>
                <Input
                    id={emailId}
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={labels.emailPlaceholder}
                    disabled={busy}
                    className="h-9 text-sm"
                />
            </div>

            <div className="space-y-1">
                <label htmlFor={passwordId} className="text-xs font-medium text-muted-foreground">
                    {labels.password}
                </label>
                <Input
                    id={passwordId}
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                        mode === "register" ? labels.passwordRegisterPlaceholder : labels.passwordLoginPlaceholder
                    }
                    disabled={busy}
                    className="h-9 text-sm"
                />
            </div>

            {error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}

            <Button type="submit" size="sm" className="w-full" disabled={busy || email === "" || password === ""}>
                {busy ? (
                    <>
                        <Loader2 className="size-4 animate-spin" />
                        {mode === "login" ? labels.signingIn : labels.creatingAccount}
                    </>
                ) : mode === "login" ? (
                    labels.logIn
                ) : (
                    labels.createAccount
                )}
            </Button>

            {mode === "register" ? (
                <p className="text-center text-xs text-muted-foreground">{labels.registerHint}</p>
            ) : null}
        </form>
    );
}

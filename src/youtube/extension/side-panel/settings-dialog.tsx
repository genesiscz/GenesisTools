import { Button } from "@app/utils/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@app/utils/ui/components/dialog";
import { Input } from "@app/utils/ui/components/input";
import { DIAMOND_PACKS } from "@app/youtube/lib/billing.types";
import { useCheckout, useLogin, useLogout, useMe, useRegister, useTopup } from "@ext/api.hooks";
import { CreditCard, Gem, Loader2, LogOut } from "lucide-react";
import { type FormEvent, useState } from "react";

type AuthMode = "login" | "register";

export function SettingsDialog({
    open,
    onOpenChange,
    devMode,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    devMode?: boolean;
}) {
    const me = useMe(open);
    const user = me.data?.user;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm bg-card border-white/10" onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle className="text-lg">Account</DialogTitle>
                    <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
                        {user
                            ? "Diamonds pay for summaries and questions."
                            : "Sign in to spend diamonds on summaries and questions. New accounts start with 100."}
                    </DialogDescription>
                </DialogHeader>
                {me.isPending && open ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                    </div>
                ) : user ? (
                    <SignedInView email={user.email} credits={user.credits} devMode={devMode} />
                ) : (
                    <AuthForm />
                )}
            </DialogContent>
        </Dialog>
    );
}

function SignedInView({ email, credits, devMode }: { email: string; credits: number; devMode?: boolean }) {
    const logout = useLogout();

    return (
        <div className="space-y-3">
            <div className="rounded-lg border border-white/8 bg-black/20 p-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Signed in as</p>
                <p className="mt-1 break-all text-sm text-foreground/95">{email}</p>
                <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="text-xl leading-none" aria-hidden>
                        💎
                    </span>
                    <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">{credits}</span>
                    <span className="text-xs text-muted-foreground">diamonds</span>
                </div>
            </div>

            <DiamondPacksSection devMode={devMode} />

            <Button
                size="sm"
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
            >
                <LogOut className="size-4" /> Log out
            </Button>
        </div>
    );
}

function DiamondPacksSection({ devMode }: { devMode?: boolean }) {
    const checkout = useCheckout();
    const topup = useTopup();
    const [pendingPack, setPendingPack] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function buy(packId: string) {
        if (pendingPack) {
            return;
        }

        setError(null);
        setPendingPack(packId);
        try {
            await checkout.mutateAsync({ packId });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPendingPack(null);
        }
    }

    const unconfigured = error?.includes("not configured");

    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Get diamonds</p>
            {unconfigured ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <CreditCard className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">Payments aren't configured on this server yet.</p>
                </div>
            ) : (
                <div className="grid grid-cols-3 gap-2">
                    {DIAMOND_PACKS.map((pack) => (
                        <button
                            key={pack.id}
                            type="button"
                            disabled={pendingPack !== null}
                            onClick={() => void buy(pack.id)}
                            className="rounded-2xl border border-white/8 bg-black/20 p-3 text-left transition-colors hover:border-primary/40 disabled:opacity-60"
                        >
                            <p className="text-base font-semibold tabular-nums text-foreground">
                                {pack.diamonds.toLocaleString("en-US").replace(",", " ")} 💎
                            </p>
                            {pendingPack === pack.id ? (
                                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin" /> Opening…
                                </p>
                            ) : (
                                <p className="mt-0.5 text-sm text-muted-foreground">${pack.usd}</p>
                            )}
                            {pack.id === "pack-medium" ? (
                                <span className="mt-1.5 inline-flex rounded-full border border-primary/25 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
                                    popular
                                </span>
                            ) : null}
                        </button>
                    ))}
                </div>
            )}
            {error && !unconfigured ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}
            {devMode ? (
                <Button
                    size="sm"
                    variant="ghost"
                    className="w-full text-muted-foreground"
                    onClick={() => topup.mutate({ amount: 100 })}
                >
                    <Gem className="size-4" /> Fill diamonds +100 (dev)
                </Button>
            ) : null}
        </div>
    );
}

function AuthForm() {
    const [mode, setMode] = useState<AuthMode>("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const login = useLogin();
    const register = useRegister();
    const busy = login.isPending || register.isPending;

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
        try {
            const action = mode === "login" ? login : register;
            await action.mutateAsync({ email, password });
            setPassword("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const toggleBase = "h-7 flex-1 rounded-md text-xs font-medium transition-colors";
    const toggleActive = "bg-white/10 text-foreground";
    const toggleIdle = "text-muted-foreground hover:text-foreground";

    return (
        <form className="space-y-3" onSubmit={submit}>
            <div className="flex gap-1 rounded-lg border border-white/8 bg-black/20 p-1" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "login"}
                    className={`${toggleBase} ${mode === "login" ? toggleActive : toggleIdle}`}
                    onClick={() => switchMode("login")}
                >
                    Log in
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "register"}
                    className={`${toggleBase} ${mode === "register" ? toggleActive : toggleIdle}`}
                    onClick={() => switchMode("register")}
                >
                    Register
                </button>
            </div>

            <div className="space-y-1">
                <label htmlFor="yt-auth-email" className="text-xs font-medium text-muted-foreground">
                    Email
                </label>
                <Input
                    id="yt-auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    disabled={busy}
                    className="h-9 text-sm"
                />
            </div>

            <div className="space-y-1">
                <label htmlFor="yt-auth-password" className="text-xs font-medium text-muted-foreground">
                    Password
                </label>
                <Input
                    id="yt-auth-password"
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
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
                        {mode === "login" ? "Signing in…" : "Creating account…"}
                    </>
                ) : mode === "login" ? (
                    "Log in"
                ) : (
                    "Create account"
                )}
            </Button>

            {mode === "register" ? (
                <p className="text-center text-xs text-muted-foreground">New accounts start with 💎 100.</p>
            ) : null}
        </form>
    );
}

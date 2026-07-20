import { formatDiamonds } from "@app/youtube/ui/components/shared/diamond";
import { useLogout, useMe } from "@app/yt/api.hooks";
import { useOptionalAuthGate } from "@app/yt/components/account/auth-gate";
import { Button } from "@genesiscz/utils/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Loader2, LogIn, LogOut, Settings } from "lucide-react";

/** Header chip: Sign in CTA when logged out, diamonds + settings when logged in. */
export function AccountHeaderControl() {
    const me = useMe();
    const logout = useLogout();
    const auth = useOptionalAuthGate();

    if (me.isPending) {
        return (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-primary/15 bg-black/30 px-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Account
            </span>
        );
    }

    if (me.data?.user) {
        return (
            <div className="flex items-center gap-1.5">
                <span
                    title={me.data.user.email}
                    className="inline-flex h-8 max-w-[14rem] items-center gap-1.5 truncate rounded-full border border-primary/20 bg-primary/10 px-2.5 font-mono text-[11px] tabular-nums text-foreground/90"
                >
                    <span aria-hidden>💎</span>
                    {formatDiamonds(me.data.user.credits)}
                    <span className="truncate text-muted-foreground">{me.data.user.email}</span>
                </span>
                <Button asChild variant="ghost" size="icon" className="size-8" title="Settings">
                    <Link to="/settings">
                        <Settings className="size-3.5" />
                    </Link>
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    title="Sign out"
                    disabled={logout.isPending}
                    onClick={() => logout.mutate()}
                >
                    <LogOut className="size-3.5" />
                </Button>
            </div>
        );
    }

    return (
        <Button
            size="sm"
            variant="cyber-secondary"
            className="h-8 gap-1.5 font-mono text-[0.65rem] uppercase tracking-[0.18em]"
            onClick={() => auth?.openAuth("login")}
            disabled={!auth}
            title="Log in or register"
        >
            <LogIn className="size-3.5" />
            Log in
        </Button>
    );
}

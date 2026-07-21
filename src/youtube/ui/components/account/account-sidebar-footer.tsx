import { formatDiamonds } from "@app/youtube/ui/components/shared/diamond";
import { useLogout, useMe } from "@app/yt/api.hooks";
import { useOptionalAuthGate } from "@app/yt/components/account/auth-gate";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@genesiscz/utils/ui/components/dropdown-menu";
import { Link } from "@tanstack/react-router";
import { ChevronUp, Loader2, LogIn, LogOut, Settings as SettingsIcon } from "lucide-react";

function initialsFromEmail(email: string): string {
    const local = email.split("@")[0] ?? email;
    const parts = local.split(/[._-]+/).filter(Boolean);

    if (parts.length >= 2) {
        return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
    }

    return local.slice(0, 2).toUpperCase();
}

/** Bottom-of-sidebar account chip — Log in when signed out, menu when signed in. */
export function AccountSidebarFooter() {
    const me = useMe();
    const logout = useLogout();
    const auth = useOptionalAuthGate();

    if (me.isPending) {
        return (
            <div className="flex h-11 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Account
            </div>
        );
    }

    if (me.data?.user) {
        const email = me.data.user.email;

        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="flex h-12 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-sidebar-accent/10"
                    >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-sidebar-primary/30 bg-sidebar-primary/10 text-[11px] font-semibold text-sidebar-primary">
                            {initialsFromEmail(email)}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-sidebar-foreground">{email}</div>
                            <div className="font-mono text-[10px] tabular-nums text-sidebar-foreground/60">
                                💎 {formatDiamonds(me.data.user.credits)}
                            </div>
                        </div>
                        <ChevronUp className="size-4 shrink-0 text-sidebar-foreground/50" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-[14rem]">
                    <DropdownMenuItem asChild>
                        <Link to="/settings">
                            <SettingsIcon className="mr-2 size-4" />
                            Account & settings
                        </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        disabled={logout.isPending}
                        onSelect={() => logout.mutate()}
                        className="text-destructive focus:text-destructive"
                    >
                        <LogOut className="mr-2 size-4" />
                        Sign out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <button
            type="button"
            className="flex h-11 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-sidebar-accent/10"
            onClick={() => auth?.openAuth("login")}
            disabled={!auth}
        >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sidebar-primary/30 bg-sidebar-primary/10 text-sidebar-primary">
                <LogIn className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-sidebar-foreground">Log in</div>
                <div className="text-[10px] text-sidebar-foreground/60">Or create an account</div>
            </div>
        </button>
    );
}

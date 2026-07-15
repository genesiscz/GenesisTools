import { useMe } from "@ext/api.hooks";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";

/** 💎 balance pill — renders only while `GET /users/me` succeeds (logged in);
 *  live-updates through the `["me"]` invalidations after ask/generate/topup. */
function DiamondChip() {
    const me = useMe();

    if (!me.data) {
        return null;
    }

    return (
        <span
            title="Diamond balance"
            className="inline-flex h-6 items-center gap-1 rounded-full border border-white/8 bg-white/4 px-2 font-mono text-[11px] tabular-nums text-foreground/90"
        >
            <span aria-hidden>💎</span>
            {me.data.user.credits}
        </span>
    );
}

export function Header({
    collapsed,
    onToggleCollapse,
    onOpenSettings,
}: {
    collapsed: boolean;
    onToggleCollapse: () => void;
    onOpenSettings?: () => void;
}) {
    const Icon = collapsed ? ChevronDown : ChevronUp;
    return (
        <header className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
                <div className="size-1.5 rounded-full bg-accent" />
                <span className="text-xs font-medium tracking-wide text-foreground/90">GenesisTools</span>
                <span className="text-xs text-muted-foreground">· YouTube</span>
            </div>
            <div className="flex items-center gap-1.5">
                <DiamondChip />
                {onOpenSettings ? (
                    <button
                        type="button"
                        onClick={onOpenSettings}
                        aria-label="Account settings"
                        title="Account"
                        className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
                    >
                        <Settings className="size-3.5" strokeWidth={2} />
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={onToggleCollapse}
                    aria-label={collapsed ? "Expand panel" : "Collapse panel"}
                    title={collapsed ? "Expand" : "Collapse"}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
                >
                    <Icon className="size-3.5" strokeWidth={2} />
                </button>
            </div>
        </header>
    );
}

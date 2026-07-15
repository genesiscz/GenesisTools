import { ChevronDown, ChevronUp } from "lucide-react";

export function Header({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
    const Icon = collapsed ? ChevronDown : ChevronUp;
    return (
        <header className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
                <div className="size-1.5 rounded-full bg-accent" />
                <span className="text-xs font-medium tracking-wide text-foreground/90">GenesisTools</span>
                <span className="text-xs text-muted-foreground">· YouTube</span>
            </div>
            <button
                type="button"
                onClick={onToggleCollapse}
                aria-label={collapsed ? "Expand panel" : "Collapse panel"}
                title={collapsed ? "Expand" : "Collapse"}
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
            >
                <Icon className="size-3.5" strokeWidth={2} />
            </button>
        </header>
    );
}

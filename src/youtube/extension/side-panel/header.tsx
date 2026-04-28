import { Button } from "@app/utils/ui/components/button";
import { X } from "lucide-react";

export function Header({ onClose }: { onClose: () => void }) {
    return (
        <header className="flex items-center justify-between border-b border-primary/20 bg-black/30 px-4 py-3 backdrop-blur-xl">
            <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-secondary">GenesisTools</p>
                <h1 className="text-sm font-semibold text-foreground">YouTube Signal Deck</h1>
            </div>
            <Button variant="cyber-ghost" size="icon-sm" onClick={onClose} aria-label="Close GenesisTools panel">
                <X className="size-4" />
            </Button>
        </header>
    );
}

import { cn } from "@ui/lib/utils";
import { Fragment } from "react";

interface KbdShortcutProps {
    keys: string[];
    separator?: string;
    className?: string;
}

export function KbdShortcut({ keys, separator = "+", className }: KbdShortcutProps) {
    return (
        <span className={cn("inline-flex items-center gap-1", className)}>
            {keys.map((key, index) => (
                <Fragment key={`${key}-${index}`}>
                    <kbd className="px-2 py-1 rounded bg-muted text-xs font-mono">{key}</kbd>
                    {separator && index < keys.length - 1 && (
                        <span className="text-xs text-muted-foreground">{separator}</span>
                    )}
                </Fragment>
            ))}
        </span>
    );
}

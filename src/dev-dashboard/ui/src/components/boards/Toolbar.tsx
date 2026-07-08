import { MousePointer2, Pen, SquareDashedMousePointer, StickyNote } from "lucide-react";
import type { ComponentType } from "react";

export type Tool = "move" | "ink" | "annotate" | "note";

interface ToolDef {
    tool: Tool;
    label: string;
    key: string;
    Icon: ComponentType<{ size?: number }>;
}

const TOOLS: ToolDef[] = [
    { tool: "move", label: "Move", key: "V", Icon: MousePointer2 },
    { tool: "ink", label: "Ink", key: "P", Icon: Pen },
    { tool: "annotate", label: "Annotate", key: "A", Icon: SquareDashedMousePointer },
    { tool: "note", label: "Note", key: "N", Icon: StickyNote },
];

interface ToolbarProps {
    tool: Tool;
    onToolChange: (tool: Tool) => void;
}

export function Toolbar({ tool, onToolChange }: ToolbarProps) {
    return (
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] p-1">
            {TOOLS.map(({ tool: t, label, key, Icon }) => (
                <button
                    key={t}
                    type="button"
                    title={`${label} (${key})`}
                    onClick={() => onToolChange(t)}
                    className={
                        tool === t
                            ? "dd-btn-accent flex h-8 w-8 items-center justify-center rounded-full"
                            : "flex h-8 w-8 items-center justify-center rounded-full text-[var(--dd-text-secondary)] hover:bg-white/5 hover:text-[var(--dd-text-primary)]"
                    }
                >
                    <Icon size={16} />
                </button>
            ))}
        </div>
    );
}

import { IconTooltip } from "@ui/components/icon-button";
import {
    Frame,
    LayoutGrid,
    MousePointer2,
    Pen,
    Spline,
    SquareDashedMousePointer,
    StickyNote,
    Table2,
} from "lucide-react";
import type { ComponentType } from "react";

export type Tool = "move" | "ink" | "annotate" | "note" | "connect" | "section" | "table";

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
    { tool: "table", label: "Table", key: "T", Icon: Table2 },
    { tool: "connect", label: "Connect", key: "C", Icon: Spline },
    { tool: "section", label: "Section", key: "S", Icon: Frame },
];

interface ToolbarProps {
    tool: Tool;
    onToolChange: (tool: Tool) => void;
    onReposition?: () => void;
}

export function Toolbar({ tool, onToolChange, onReposition }: ToolbarProps) {
    return (
        <div
            data-testid="board-toolbar"
            className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] p-1"
        >
            {TOOLS.map(({ tool: t, label, key, Icon }) => (
                <IconTooltip key={t} tooltip={`${label} (${key})`} tooltipSide="top">
                    <button
                        type="button"
                        data-tool={t}
                        aria-pressed={tool === t}
                        onClick={() => onToolChange(t)}
                        className={
                            tool === t
                                ? "dd-btn-accent flex h-8 w-8 items-center justify-center rounded-full"
                                : "flex h-8 w-8 items-center justify-center rounded-full text-[var(--dd-text-secondary)] hover:bg-[var(--dd-bg-hover)] hover:text-[var(--dd-text-primary)]"
                        }
                    >
                        <Icon size={16} />
                    </button>
                </IconTooltip>
            ))}
            {onReposition ? (
                <>
                    <span className="mx-0.5 my-1 w-px bg-[var(--dd-border)]" />
                    <IconTooltip tooltip="Reposition — repack cards without overlaps" tooltipSide="top">
                        <button
                            type="button"
                            data-testid="reposition-button"
                            onClick={onReposition}
                            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--dd-text-secondary)] hover:bg-[var(--dd-bg-hover)] hover:text-[var(--dd-text-primary)]"
                        >
                            <LayoutGrid size={16} />
                        </button>
                    </IconTooltip>
                </>
            ) : null}
        </div>
    );
}

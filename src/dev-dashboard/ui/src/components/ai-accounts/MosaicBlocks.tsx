import { IconButton } from "@ui/components/icon-button";
import { EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";

interface MosaicBlocksProps {
    node: MosaicNode<string> | null;
    onChange: (next: MosaicNode<string> | null) => void;
    labels: Record<string, string>;
    hidden: string[];
    onHide: (id: string) => void;
    onShow: (id: string) => void;
    onReset: () => void;
    /** Renders the body of one block. */
    render: (id: string) => ReactNode;
}

/**
 * The section as react-mosaic tiles: drag a title bar to move a block, drag a split to
 * resize, hide from the toolbar. Same component family and `dd-mosaic` skin as the ttyd and
 * cmux pages, so the whole dashboard reorganises the same way.
 */
export function MosaicBlocks({ node, onChange, labels, hidden, onHide, onShow, onReset, render }: MosaicBlocksProps) {
    return (
        <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="min-h-0 flex-1 overflow-hidden">
                {node ? (
                    <Mosaic<string>
                        value={node}
                        onChange={onChange}
                        className="dd-mosaic"
                        renderTile={(id, path) => (
                            <MosaicWindow<string>
                                path={path}
                                title={labels[id] ?? id}
                                additionalControls={null}
                                toolbarControls={
                                    <IconButton
                                        size="icon-sm"
                                        variant="ghost"
                                        tooltip={`Hide ${labels[id] ?? id}`}
                                        className="text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                                        onClick={() => onHide(id)}
                                    >
                                        <EyeOff size={12} />
                                    </IconButton>
                                }
                            >
                                <div className="dd-scroll-region h-full overflow-auto p-3">{render(id)}</div>
                            </MosaicWindow>
                        )}
                    />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        Every block is hidden. Show one below.
                    </div>
                )}
            </div>

            {hidden.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                    <span>Hidden:</span>
                    {hidden.map((id) => (
                        <button
                            key={id}
                            type="button"
                            className="dd-ai-chip"
                            aria-pressed={false}
                            onClick={() => onShow(id)}
                        >
                            {labels[id] ?? id}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline"
                        onClick={onReset}
                    >
                        reset layout
                    </button>
                </div>
            ) : null}
        </div>
    );
}

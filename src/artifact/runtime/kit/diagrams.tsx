import { type ReactNode, useEffect, useRef, useState } from "react";
import { MERMAID_ERROR_CLASS, MERMAID_FRAME_CLASS, type MermaidRenderResult, renderMermaidSvg } from "./mermaid-core";

/**
 * Diagram surfaces. `Mermaid` renders mermaid source (flowchart, sequence,
 * state, class, ER, gantt, gitGraph, mindmap, timeline, …) through the shared
 * loader in mermaid-core.ts; ```mermaid fences inside Md/MdViewer go through
 * the same loader, so a diagram in a markdown body and a diagram in JSX look
 * identical. `ZoomPane` is the scroll + zoom frame around it, reusable for any
 * oversized SVG or image.
 */

const TOOL_BUTTON =
    "rounded-card border border-line bg-panel/90 px-2 py-0.5 font-mono text-[0.68rem] text-dim hover:border-accent hover:text-ink";

export interface ZoomPaneProps {
    children: ReactNode;
    /** Extra toolbar buttons, rendered before the zoom controls. */
    tools?: ReactNode;
    min?: number;
    max?: number;
    step?: number;
    /** Scroll inside the pane past this height (CSS length or px). */
    maxHeight?: number | string;
    /** Names the toolbar for assistive technology. */
    label?: string;
    className?: string;
}

/**
 * Scrollable frame with a zoom toolbar. CSS `zoom` (not `transform`) so the
 * content's layout box grows with it and the scrollbars follow.
 */
export function ZoomPane({
    children,
    tools,
    min = 0.5,
    max = 4,
    step = 0.25,
    maxHeight,
    label,
    className,
}: ZoomPaneProps) {
    const [zoom, setZoom] = useState(1);
    const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next * 100) / 100));

    return (
        <div
            className={`group relative overflow-hidden rounded-card border border-line bg-canvas/60 ${className ?? ""}`}
        >
            <div
                role="toolbar"
                aria-label={label ? `${label} tools` : "diagram tools"}
                className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
            >
                {tools}
                <button
                    type="button"
                    aria-label="zoom out"
                    className={TOOL_BUTTON}
                    onClick={() => setZoom((z) => clamp(z - step))}
                >
                    -
                </button>
                <button type="button" aria-label="reset zoom" className={TOOL_BUTTON} onClick={() => setZoom(1)}>
                    {Math.round(zoom * 100)}%
                </button>
                <button
                    type="button"
                    aria-label="zoom in"
                    className={TOOL_BUTTON}
                    onClick={() => setZoom((z) => clamp(z + step))}
                >
                    +
                </button>
            </div>
            <div className="overflow-auto p-3" style={{ maxHeight }}>
                <div style={{ zoom }}>{children}</div>
            </div>
        </div>
    );
}

export interface MermaidProps {
    /** Mermaid source text, exactly what would sit inside a ```mermaid fence. */
    chart: string;
    caption?: string;
    /** Zoom toolbar + scroll frame (default on). Off renders the bare SVG. */
    zoom?: boolean;
    maxHeight?: number | string;
    className?: string;
}

interface MermaidState {
    svg?: string;
    bind?: MermaidRenderResult["bindFunctions"];
    error?: string;
}

function downloadSvg(svg: string, name: string): void {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.svg`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Render a mermaid diagram. The library loads on first use (see
 * mermaid-core.ts for where from); a syntax error shows mermaid's message
 * above the source instead of a blank frame.
 */
export function Mermaid({ chart, caption, zoom = true, maxHeight, className }: MermaidProps) {
    const [state, setState] = useState<MermaidState>({});
    const [copied, setCopied] = useState(false);
    const frameRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        setState({});
        renderMermaidSvg(chart)
            .then(({ svg, bindFunctions }) => {
                if (!cancelled) {
                    setState({ svg, bind: bindFunctions });
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setState({ error: err instanceof Error ? err.message : String(err) });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [chart]);

    useEffect(() => {
        if (state.svg && state.bind && frameRef.current) {
            state.bind(frameRef.current);
        }
    }, [state]);

    const copySource = (): void => {
        if (!navigator.clipboard) {
            return;
        }

        navigator.clipboard
            .writeText(chart)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => setCopied(false));
    };

    let body: ReactNode;

    if (state.error) {
        body = (
            <div>
                <div className={MERMAID_ERROR_CLASS}>mermaid: {state.error}</div>
                <pre className="overflow-x-auto p-2 font-mono text-[0.8rem] leading-relaxed text-dim">{chart}</pre>
            </div>
        );
    } else if (!state.svg) {
        body = <div className="animate-pulse p-6 text-center text-sm text-dim">rendering diagram…</div>;
    } else {
        body = (
            <div
                ref={frameRef}
                className={MERMAID_FRAME_CLASS}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's own sanitized SVG output (securityLevel strict)
                dangerouslySetInnerHTML={{ __html: state.svg }}
            />
        );
    }

    const tools = (
        <>
            <button type="button" className={TOOL_BUTTON} onClick={copySource}>
                {copied ? "copied" : "copy source"}
            </button>
            {state.svg ? (
                <button
                    type="button"
                    className={TOOL_BUTTON}
                    onClick={() => downloadSvg(state.svg ?? "", caption ?? "diagram")}
                >
                    svg
                </button>
            ) : null}
        </>
    );

    return (
        <figure className={`my-3 ${className ?? ""}`}>
            {zoom ? (
                <ZoomPane tools={tools} maxHeight={maxHeight} label={caption}>
                    {body}
                </ZoomPane>
            ) : (
                <div className="rounded-card border border-line bg-canvas/60 p-3">{body}</div>
            )}
            {caption ? <figcaption className="mt-1.5 text-center text-xs text-dim">{caption}</figcaption> : null}
        </figure>
    );
}

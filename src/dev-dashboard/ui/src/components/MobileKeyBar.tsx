import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp } from "lucide-react";
import { useEffect, useState } from "react";
import type { IframeKey } from "@/lib/iframe-keys";

interface MobileKeyBarProps {
    onKey: (key: IframeKey) => void;
    onScroll: (lines: number) => void;
    onPageScroll?: (direction: -1 | 1) => void;
    /** Tweak how many lines a PgUp/PgDn tap scrolls. Defaults to 10. */
    scrollStep?: number;
    /** In document flow at the bottom of the ttyd shell (not fixed over the terminal). */
    embedded?: boolean;
}

interface KeySpec {
    label: string;
    aria: string;
    icon?: React.ReactNode;
    action: () => void;
    accent?: boolean;
}

/**
 * Tiny on-screen key bar for mobile ttyd. Sticks just above the OS keyboard
 * using window.visualViewport (the only API iOS Safari actually honours),
 * and falls back to bottom-of-viewport when no soft keyboard is open.
 */
export function MobileKeyBar({ onKey, onScroll, onPageScroll, scrollStep = 10, embedded = false }: MobileKeyBarProps) {
    const [bottomOffset, setBottomOffset] = useState(0);

    useEffect(() => {
        if (embedded) {
            return;
        }

        const vv = window.visualViewport;
        if (!vv) {
            return;
        }

        const sync = () => {
            // visualViewport.height shrinks when the OS keyboard rises; the
            // gap between layout viewport and visual viewport is the keyboard.
            const layoutH = window.innerHeight;
            const visualH = vv.height + vv.offsetTop;
            const keyboard = Math.max(0, layoutH - visualH);
            setBottomOffset(keyboard);
        };

        sync();
        vv.addEventListener("resize", sync);
        vv.addEventListener("scroll", sync);

        return () => {
            vv.removeEventListener("resize", sync);
            vv.removeEventListener("scroll", sync);
        };
    }, [embedded]);

    const keys: KeySpec[] = [
        { label: "Esc", aria: "Escape", action: () => onKey("Escape"), accent: true },
        { label: "Tab", aria: "Tab", action: () => onKey("Tab") },
        { label: "←", aria: "Arrow left", icon: <ArrowLeft size={16} />, action: () => onKey("ArrowLeft") },
        { label: "↑", aria: "Arrow up", icon: <ArrowUp size={16} />, action: () => onKey("ArrowUp") },
        { label: "↓", aria: "Arrow down", icon: <ArrowDown size={16} />, action: () => onKey("ArrowDown") },
        { label: "→", aria: "Arrow right", icon: <ArrowRight size={16} />, action: () => onKey("ArrowRight") },
        { label: "PgUp", aria: "Scroll up", icon: <ChevronsUp size={16} />, action: () => (onPageScroll ? onPageScroll(-1) : onScroll(-scrollStep)) },
        { label: "PgDn", aria: "Scroll down", icon: <ChevronsDown size={16} />, action: () => (onPageScroll ? onPageScroll(1) : onScroll(scrollStep)) },
    ];

    return (
        <div
            className={embedded ? "dd-keybar dd-keybar--embedded" : "dd-keybar"}
            style={embedded ? undefined : { bottom: bottomOffset }}
            role="toolbar"
            aria-label="terminal keys"
        >
            {keys.map((k) => (
                <button
                    key={k.aria}
                    type="button"
                    className={k.accent ? "dd-keybar-key is-accent" : "dd-keybar-key"}
                    aria-label={k.aria}
                    onPointerDown={(e) => {
                        // Prevent the OS keyboard from losing focus on tap — keeps
                        // typing flow intact while still firing the key on the iframe.
                        e.preventDefault();
                        k.action();
                    }}
                >
                    {k.icon ?? <span className="dd-keybar-label">{k.label}</span>}
                </button>
            ))}
        </div>
    );
}

import { useEffect, useRef } from "react";

interface RainEffectProps {
    /** Number of rain drops. Default 50. */
    dropCount?: number;
}

/**
 * Animated violet rain drops across the parent container.
 * Parent must be `position: relative` for the drops to layer correctly.
 * Uses `.rain-bg` and `.rain-drop` classes from wow-components.css.
 */
export function RainEffect({ dropCount = 50 }: RainEffectProps) {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        for (let i = 0; i < dropCount; i++) {
            const drop = document.createElement("div");
            drop.className = "rain-drop";
            drop.style.left = `${Math.random() * 100}%`;
            drop.style.animationDelay = `${Math.random() * 3}s`;
            drop.style.animationDuration = `${1 + Math.random() * 2}s`;
            drop.style.opacity = `${0.1 + Math.random() * 0.3}`;
            drop.style.height = `${60 + Math.random() * 40}px`;
            container.appendChild(drop);
        }

        return () => {
            container.innerHTML = "";
        };
    }, [dropCount]);

    return <div ref={containerRef} className="rain-bg" />;
}

import { useEffect } from "react";

/** Keeps mobile terminal chrome sized to the visible viewport (keyboard-aware). */
export function useVisualViewportSize(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) {
            return;
        }

        const root = document.documentElement;

        const sync = () => {
            const vv = window.visualViewport;

            if (!vv) {
                return;
            }

            root.style.setProperty("--dd-vv-height", `${vv.height}px`);
            root.style.setProperty("--dd-vv-offset-top", `${vv.offsetTop}px`);
        };

        sync();
        window.visualViewport?.addEventListener("resize", sync);
        window.visualViewport?.addEventListener("scroll", sync);

        return () => {
            window.visualViewport?.removeEventListener("resize", sync);
            window.visualViewport?.removeEventListener("scroll", sync);
            root.style.removeProperty("--dd-vv-height");
            root.style.removeProperty("--dd-vv-offset-top");
        };
    }, [enabled]);
}

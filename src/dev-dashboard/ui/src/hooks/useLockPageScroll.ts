import { useEffect } from "react";

/** Keep the dashboard shell pinned — iOS visualViewport scroll must not move the page. */
export function useLockPageScroll(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) {
            return;
        }

        const lock = () => {
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
        };

        lock();
        window.addEventListener("scroll", lock, { passive: true });
        window.visualViewport?.addEventListener("scroll", lock);
        window.visualViewport?.addEventListener("resize", lock);

        return () => {
            window.removeEventListener("scroll", lock);
            window.visualViewport?.removeEventListener("scroll", lock);
            window.visualViewport?.removeEventListener("resize", lock);
        };
    }, [enabled]);
}

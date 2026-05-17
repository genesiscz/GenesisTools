import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";

export type LayoutMode = "mosaic" | "focused";

// Same-tab localStorage writes do NOT emit a `storage` event (that is
// cross-tab only), so a manual toggle in a route wouldn't reach the Shell's
// own hook until navigation. This custom event keeps every useLayoutMode
// consumer in sync within the tab.
const LAYOUT_CHANGE_EVENT = "dd:layout-change";

export function resolveLayoutMode(args: { isMobile: boolean; stored: LayoutMode | null }): LayoutMode {
    if (args.isMobile) {
        return "focused";
    }

    return args.stored ?? "mosaic";
}

function readStored(storageKey: string): LayoutMode | null {
    if (typeof window === "undefined") {
        return null;
    }

    const value = window.localStorage.getItem(storageKey);
    return value === "focused" || value === "mosaic" ? value : null;
}

export function useLayoutMode(routeKey: string): {
    mode: LayoutMode;
    isMobile: boolean;
    setMode: (next: LayoutMode) => void;
} {
    const isMobile = useMediaQuery("(max-width: 768px)");
    const storageKey = `dd:layout:${routeKey}`;
    const [stored, setStored] = useState<LayoutMode | null>(() => readStored(storageKey));

    const setMode = useCallback(
        (next: LayoutMode) => {
            setStored(next);
            window.localStorage.setItem(storageKey, next);
            window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
        },
        [storageKey]
    );

    useEffect(() => {
        const sync = () => setStored(readStored(storageKey));

        sync();
        window.addEventListener(LAYOUT_CHANGE_EVENT, sync);

        return () => window.removeEventListener(LAYOUT_CHANGE_EVENT, sync);
    }, [storageKey]);

    return { mode: resolveLayoutMode({ isMobile, stored }), isMobile, setMode };
}

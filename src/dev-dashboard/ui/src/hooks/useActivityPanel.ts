import { useCallback, useEffect, useState } from "react";

export type ActivityPanelState = "collapsed" | "expanded";

// Same-tab localStorage writes do NOT emit a `storage` event (cross-tab
// only), so this custom event keeps every useActivityPanel consumer in sync
// within the tab — mirrors useLayoutMode.ts.
const ACTIVITY_PANEL_CHANGE_EVENT = "dd:activity-panel-change";
const STORAGE_KEY = "dd:handoff:activity-panel";

function readStored(): ActivityPanelState | null {
    if (typeof window === "undefined") {
        return null;
    }

    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "collapsed" || value === "expanded" ? value : null;
}

export function useActivityPanel(): {
    state: ActivityPanelState;
    setState: (next: ActivityPanelState) => void;
} {
    const [stored, setStored] = useState<ActivityPanelState | null>(() => readStored());

    const setState = useCallback((next: ActivityPanelState) => {
        setStored(next);
        window.localStorage.setItem(STORAGE_KEY, next);
        window.dispatchEvent(new Event(ACTIVITY_PANEL_CHANGE_EVENT));
    }, []);

    useEffect(() => {
        const sync = () => setStored(readStored());

        sync();
        window.addEventListener(ACTIVITY_PANEL_CHANGE_EVENT, sync);

        return () => window.removeEventListener(ACTIVITY_PANEL_CHANGE_EVENT, sync);
    }, []);

    return { state: stored ?? "collapsed", setState };
}

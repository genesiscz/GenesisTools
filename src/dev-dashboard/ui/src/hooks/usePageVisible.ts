import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
    document.addEventListener("visibilitychange", onChange);

    return () => document.removeEventListener("visibilitychange", onChange);
}

function isPageVisible(): boolean {
    return document.visibilityState !== "hidden";
}

/** False while the tab is in the background or the phone screen is off. */
export function usePageVisible(): boolean {
    return useSyncExternalStore(subscribe, isPageVisible, () => true);
}

import type { ExtensionEvent } from "@ext/shared/messages";

export function connectEventPort(): () => void {
    const port = chrome.runtime.connect({ name: "side-panel" });

    port.onMessage.addListener((message) => {
        const event = message as ExtensionEvent;
        document.dispatchEvent(new CustomEvent("yt-extension-event", { detail: event }));
    });

    return () => port.disconnect();
}

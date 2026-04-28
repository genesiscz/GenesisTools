import { SidePanel } from "@ext/side-panel/side-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@ext/side-panel/side-panel.css";

let mountedRoot: Root | null = null;
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });

export function mountSidePanel(shadow: ShadowRoot, videoId: string | null, onClose: () => void): void {
    if (mountedRoot) {
        mountedRoot.unmount();
        mountedRoot = null;
    }

    shadow.replaceChildren();
    const root = document.createElement("div");
    root.className = "cyberpunk genesis-yt-extension-root";
    shadow.appendChild(root);

    mountedRoot = createRoot(root);
    mountedRoot.render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <SidePanel videoId={videoId} onClose={onClose} />
            </QueryClientProvider>
        </StrictMode>
    );
}

export function unmountSidePanel(shadow: ShadowRoot | null): void {
    if (mountedRoot) {
        mountedRoot.unmount();
        mountedRoot = null;
    }

    shadow?.replaceChildren();
}

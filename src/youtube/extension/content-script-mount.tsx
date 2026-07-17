import { logger } from "@app/logger/client";
import { PortalContainerProvider } from "@app/utils/ui/components/select";
import { SidePanel } from "@ext/side-panel/side-panel";
import sidePanelCss from "@ext/side-panel/side-panel.css?inline";
import type { PanelTarget } from "@ext/side-panel/target";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Chromium ignores `@property` rules inside shadow roots, so Tailwind's
// `--tw-*` registrations (all `inherits: false`) never take effect here and
// the variables fall back to plain inheriting custom properties — e.g. the
// dialog's `translate-x-[-50%]` leaks into its buttons, whose
// `hover:-translate-y-px` then computes `translate: -50% -1px`. Tailwind
// ships an equivalent fallback (`@layer properties` universal rule resetting
// every var) but hides it behind a @supports guard that is false in
// Chromium. Strip the guard so the fallback always applies in the shadow.
const PROPERTY_FALLBACK_GUARD = /@supports \(\(\(-webkit-hyphens:\s*none\)\).*?\(from red r g b\)\)\)\)/;
const guardFound = PROPERTY_FALLBACK_GUARD.test(sidePanelCss);

if (!guardFound) {
    logger.warn("[genesis-yt] Tailwind @property fallback guard not found — --tw-* vars will inherit in shadow DOM");
}

const scopedCss = guardFound ? sidePanelCss.replace(PROPERTY_FALLBACK_GUARD, "@supports (color:red)") : sidePanelCss;

let mountedRoot: Root | null = null;
// retry: false — our API surfaces "video not found" and other terminal 4xx
// responses. Retrying keeps `isPending: true` for 7+ seconds (v5 default =
// 3 retries, 1s+2s+4s backoff), which reads as a broken "Loading summary"
// spinner. Fail fast; the empty state handles missing data.
const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } },
});

export function mountSidePanel(shadow: ShadowRoot, target: PanelTarget, placement: "inline" | "fixed"): void {
    if (mountedRoot) {
        mountedRoot.unmount();
        mountedRoot = null;
    }

    shadow.replaceChildren();
    const style = document.createElement("style");
    style.textContent = scopedCss;
    shadow.appendChild(style);
    const root = document.createElement("div");
    root.className = "genesis-yt-extension-root";
    root.dataset.placement = placement;
    shadow.appendChild(root);
    // Sibling of `root` — a portal target inside the shadow root so Radix
    // popups (Select, Dialog…) render here instead of `document.body`,
    // inheriting the scoped Tailwind CSS.
    const portalTarget = document.createElement("div");
    portalTarget.className = "genesis-yt-extension-root";
    portalTarget.dataset.slot = "portal";
    shadow.appendChild(portalTarget);

    mountedRoot = createRoot(root);
    mountedRoot.render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <PortalContainerProvider container={portalTarget}>
                    <SidePanel target={target} placement={placement} />
                </PortalContainerProvider>
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

import { mountSidePanel, unmountSidePanel } from "@ext/content-script-mount";
import type { PanelTarget } from "@ext/side-panel/target";

declare global {
    interface Window {
        // Set by whichever content-script version is currently mounted so a
        // re-inject via chrome.scripting.executeScript can wipe the old
        // instance before the new one mounts. No page reload, video keeps
        // playing.
        __genesisYtCleanup?: () => void;
    }
}

// Wipe any previous instance's DOM + listeners before we set up.
if (typeof window !== "undefined" && window.__genesisYtCleanup) {
    try {
        window.__genesisYtCleanup();
    } catch {}
}

const hostId = "genesis-yt-side-panel";
type Placement = "inline" | "fixed";

function isChannelPath(pathname: string): boolean {
    return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+)/.test(pathname);
}

function getChannelHandle(pathname: string): string | null {
    const fromPath = pathname.match(/^\/(@[^/?#]+)/);
    if (fromPath) {
        return decodeURIComponent(fromPath[1]);
    }

    // /channel/<id> and /c/<name> don't carry the @handle; YouTube's canonical
    // link points at the @handle URL, so recover it from there when present.
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    const fromCanonical = canonical?.match(/youtube\.com\/(@[^/?#]+)/);
    return fromCanonical ? decodeURIComponent(fromCanonical[1]) : null;
}

function getPanelTarget(): PanelTarget | null {
    const url = new URL(location.href);

    if (url.pathname === "/watch") {
        const videoId = url.searchParams.get("v");
        return videoId ? { kind: "video", videoId } : null;
    }

    const shorts = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shorts) {
        return { kind: "video", videoId: decodeURIComponent(shorts[1]) };
    }

    if (url.pathname === "/playlist") {
        const listId = url.searchParams.get("list");
        return listId ? { kind: "playlist", listId } : null;
    }

    if (isChannelPath(url.pathname)) {
        return { kind: "channel", handle: getChannelHandle(url.pathname) };
    }

    return null;
}

function findWatchSecondaryColumn(): HTMLElement | null {
    // On a watch page, ytd-watch-flexy renders #primary + #secondary siblings;
    // #secondary is the related-videos rail. Injecting there makes the panel
    // flow with the page instead of covering the video.
    return document.querySelector<HTMLElement>("ytd-watch-flexy #secondary");
}

const HEIGHT_ANIMATION = [
    "interpolate-size: allow-keywords",
    "transition: height 400ms cubic-bezier(0.4, 0, 0.2, 1)",
].join("; ");

function shieldKeyboardEvents(host: HTMLElement): void {
    // YouTube's document-level hotkeys (space = pause, m = mute, …) fire even
    // while the user types in the panel's inputs — key events bubble out of
    // the shadow root, retargeted to the host. Stop them at the host so YT
    // never sees them; React handlers inside the shadow already ran. Escape
    // is let through only for Radix's document-level dismiss listeners.
    for (const type of ["keydown", "keyup", "keypress"] as const) {
        host.addEventListener(type, (event) => {
            if ((event as KeyboardEvent).key !== "Escape") {
                event.stopPropagation();
            }
        });
    }
}

function applyInlineStyles(host: HTMLElement): void {
    // Auto-height: panel matches its content, growing smoothly when tab data
    // loads. Capped by max-height (viewport-relative) with overflow-y inside
    // the panel itself. `interpolate-size` + transition are set on the host
    // element itself so height:auto → height:auto changes animate.
    host.style.cssText = [
        "display: block",
        "width: 100%",
        "position: relative",
        "margin-bottom: 16px",
        "height: auto",
        "min-height: 120px",
        // Cap well below the viewport so recommendations stay visible; the
        // panel body scrolls inside. `overflow: hidden` so content can never
        // paint past the cap over the rail below.
        "max-height: min(60vh, 640px)",
        "overflow: hidden",
        // Above the covered rail content — YouTube's chip-scroller arrows and
        // video-item ⋮ menu buttons create positioned boxes that otherwise
        // paint through the panel (they live in later siblings). YT's real
        // popups mount in a body-level container far above this, unaffected.
        "z-index: 2000",
        HEIGHT_ANIMATION,
    ].join("; ");
}

function applyFixedStyles(host: HTMLElement): void {
    host.style.cssText = [
        "position: fixed",
        "right: 16px",
        "top: 72px",
        "width: 400px",
        "height: auto",
        "min-height: 120px",
        "max-height: min(calc(100vh - 96px), 900px)",
        "z-index: 2147483647",
        "pointer-events: auto",
        HEIGHT_ANIMATION,
    ].join("; ");
}

function attachHost(target: PanelTarget): { host: HTMLElement; placement: Placement } {
    const existing = document.getElementById(hostId);
    if (existing) {
        existing.remove();
    }

    const host = document.createElement("div");
    host.id = hostId;
    shieldKeyboardEvents(host);

    if (target.kind === "video" && location.pathname === "/watch") {
        const secondary = findWatchSecondaryColumn();
        if (secondary) {
            applyInlineStyles(host);
            secondary.insertBefore(host, secondary.firstChild);
            return { host, placement: "inline" };
        }
    }

    applyFixedStyles(host);
    document.body.appendChild(host);
    return { host, placement: "fixed" };
}

function ensureSidePanel(): void {
    const target = getPanelTarget();

    if (!target) {
        removeSidePanel();
        return;
    }

    const { host, placement } = attachHost(target);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    mountSidePanel(shadow, target, placement, () => removeSidePanel());
}

function removeSidePanel(): void {
    const host = document.getElementById(hostId);
    if (!host) {
        return;
    }

    unmountSidePanel(host.shadowRoot);
    host.remove();
}

function scheduleMount(): void {
    // #secondary is populated asynchronously on watch nav; retry until it
    // exists, otherwise the fixed fallback kicks in after the attempt cap.
    let attempts = 0;
    const tryMount = (): void => {
        ensureSidePanel();
        attempts += 1;
        const target = getPanelTarget();
        const stillWaiting =
            target?.kind === "video" && location.pathname === "/watch" && !findWatchSecondaryColumn() && attempts < 20;
        if (stillWaiting) {
            window.setTimeout(tryMount, 250);
        }
    };
    tryMount();
}

scheduleMount();
window.addEventListener("yt-navigate-finish", scheduleMount);
window.addEventListener("popstate", scheduleMount);

window.__genesisYtCleanup = () => {
    removeSidePanel();
    window.removeEventListener("yt-navigate-finish", scheduleMount);
    window.removeEventListener("popstate", scheduleMount);
};

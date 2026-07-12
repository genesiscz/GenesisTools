import { mountSidePanel, unmountSidePanel } from "@ext/content-script-mount";
import type { PanelTarget } from "@ext/side-panel/target";

const hostId = "genesis-yt-side-panel";

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

    if (isChannelPath(url.pathname)) {
        return { kind: "channel", handle: getChannelHandle(url.pathname) };
    }

    return null;
}

function ensureSidePanel(): void {
    const target = getPanelTarget();

    if (!target) {
        removeSidePanel();
        return;
    }

    let host = document.getElementById(hostId);
    if (!host) {
        host = document.createElement("div");
        host.id = hostId;
        host.style.position = "fixed";
        host.style.right = "0";
        host.style.top = "56px";
        host.style.bottom = "0";
        host.style.width = "430px";
        host.style.zIndex = "2147483647";
        document.body.appendChild(host);
    }

    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    mountSidePanel(shadow, target, () => removeSidePanel());
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
    window.setTimeout(() => ensureSidePanel(), 250);
}

scheduleMount();
window.addEventListener("yt-navigate-finish", scheduleMount);
window.addEventListener("popstate", scheduleMount);

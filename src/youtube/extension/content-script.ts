import { mountSidePanel, unmountSidePanel } from "@ext/content-script-mount";

const hostId = "genesis-yt-side-panel";

function getVideoId(): string | null {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") : null;
}

function ensureSidePanel(): void {
    const videoId = getVideoId();

    if (!videoId) {
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
    mountSidePanel(shadow, videoId, () => removeSidePanel());
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

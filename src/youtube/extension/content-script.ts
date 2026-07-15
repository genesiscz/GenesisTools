import { mountSidePanel, unmountSidePanel } from "@ext/content-script-mount";
import { type ChapterTicksHandle, mountChapterTicks } from "@ext/player-chapters";
import type { PlayerChaptersMessage, PlayerTimeMessage } from "@ext/shared/messages";
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

function isInFlowRail(el: HTMLElement): boolean {
    // #secondary is normally an in-flow right column (computed position static
    // or relative). On playlist + live-chat watch layouts YouTube switches it
    // to position: fixed and pins it to the LEFT (measured x=0, near-full
    // width), so inserting our panel as its child paints it over the video.
    // Only flow inline when #secondary is a normal in-flow rail; otherwise the
    // caller uses the fixed host fallback, which pins us to the right clear of
    // the player.
    const position = getComputedStyle(el).position;
    return position === "static" || position === "relative";
}

function findLiveChatFrame(): HTMLElement | null {
    // Livestreams / premieres (incl. playlist + chat layouts) render a
    // ytd-live-chat-frame. The user wants the panel stacked directly ABOVE the
    // chat, in its column — inserting the host as the chat's previous sibling
    // does exactly that regardless of which container YouTube parked the chat
    // in.
    return document.querySelector<HTMLElement>("ytd-live-chat-frame");
}

function coversPlayer(host: HTMLElement): boolean {
    // Safety net for responsive edge cases: whatever container we picked, if
    // the panel actually landed on top of the video we retreat to the fixed
    // right-side host instead. getBoundingClientRect forces a sync reflow so
    // the measurement is accurate right after insertion.
    const player =
        document.querySelector<HTMLElement>("#movie_player") ?? document.querySelector<HTMLElement>("ytd-player");

    if (!player) {
        return false;
    }

    const h = host.getBoundingClientRect();
    const p = player.getBoundingClientRect();

    if (h.width === 0 || p.width === 0) {
        return false;
    }

    const horizontal = Math.min(h.right, p.right) - Math.max(h.left, p.left);
    const vertical = Math.min(h.bottom, p.bottom) - Math.max(h.top, p.top);
    return horizontal > 40 && vertical > 40;
}

function tryInlinePlacement(host: HTMLElement, insert: () => void): boolean {
    applyInlineStyles(host);
    insert();

    if (coversPlayer(host)) {
        host.remove();
        return false;
    }

    return true;
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
        // When placed above the live chat, the parent is a flex column — without
        // this the host inherits flex-shrink:1 and gets squeezed into the
        // leftover space, clipping its own content. Pin natural height so it
        // takes its content size and pushes the chat down. No effect in a
        // non-flex rail parent.
        "flex: 0 0 auto",
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
        // Prefer sitting directly above the live chat when one is present.
        const chat = findLiveChatFrame();
        if (chat?.parentElement) {
            const parent = chat.parentElement;
            if (tryInlinePlacement(host, () => parent.insertBefore(host, chat))) {
                return { host, placement: "inline" };
            }
        }

        // Otherwise flow at the top of the related-videos rail, but only when
        // #secondary is a normal in-flow column (see isInFlowRail).
        const secondary = findWatchSecondaryColumn();
        if (secondary && isInFlowRail(secondary)) {
            if (tryInlinePlacement(host, () => secondary.insertBefore(host, secondary.firstChild))) {
                return { host, placement: "inline" };
            }
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
        ensureChapterTicks();
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

// --- Chapter ticks on the player progress bar (page DOM, gt-chapter- styles) ---

let chapterData: PlayerChaptersMessage | null = null;
let ticks: ChapterTicksHandle | null = null;
let ticksBar: HTMLElement | null = null;
let observedPlayer: HTMLElement | null = null;
let playerObserver: MutationObserver | null = null;
let remountTimer: number | null = null;
let lastPlayerTime = 0;

function currentVideoId(): string | null {
    const target = getPanelTarget();
    return target?.kind === "video" ? target.videoId : null;
}

function findVideoEl(): HTMLVideoElement | null {
    return (
        document.querySelector<HTMLVideoElement>("#movie_player video") ??
        document.querySelector<HTMLVideoElement>("video")
    );
}

function seekPlayer(seconds: number): void {
    // Same bridge the panel's timestamp pills use.
    window.postMessage({ event: "command", func: "seekTo", args: [seconds, true] }, "https://www.youtube.com");
}

function unmountTicks(): void {
    ticks?.unmount();
    ticks = null;
    ticksBar = null;
}

function ensureChapterTicks(): void {
    const videoId = currentVideoId();

    if (!chapterData || chapterData.chapters.length === 0 || !videoId || chapterData.videoId !== videoId) {
        unmountTicks();
        return;
    }

    const bar = document.querySelector<HTMLElement>(".ytp-progress-bar");
    const duration = findVideoEl()?.duration;

    if (!bar || duration === undefined || !Number.isFinite(duration) || duration <= 0) {
        // Bar or duration not ready yet — the 1 Hz tick retries.
        unmountTicks();
        return;
    }

    if (ticks && ticksBar === bar && bar.isConnected) {
        return;
    }

    unmountTicks();
    ticks = mountChapterTicks({ chapters: chapterData.chapters, duration, container: bar, onSeek: seekPlayer });
    ticksBar = bar;
    ticks.setCurrentTime(lastPlayerTime);
}

function ensurePlayerObserver(): void {
    const player = document.getElementById("movie_player");

    if (!player || player === observedPlayer) {
        return;
    }

    playerObserver?.disconnect();
    observedPlayer = player;
    playerObserver = new MutationObserver(() => {
        // Fullscreen/theater swap the progress-bar nodes; debounce the re-find.
        if (remountTimer !== null) {
            return;
        }

        remountTimer = window.setTimeout(() => {
            remountTimer = null;
            ensureChapterTicks();
        }, 100);
    });
    playerObserver.observe(player, { childList: true, subtree: true });
}

function onChaptersMessage(event: MessageEvent): void {
    if (event.source !== window) {
        return;
    }

    const data = event.data as { type?: unknown; videoId?: unknown; chapters?: unknown } | null;

    if (data?.type !== "player:chapters" || typeof data.videoId !== "string" || !Array.isArray(data.chapters)) {
        return;
    }

    const chapters: PlayerChaptersMessage["chapters"] = [];

    for (const chapter of data.chapters) {
        const raw = chapter as { title?: unknown; startSec?: unknown } | null;

        if (raw && typeof raw.title === "string" && typeof raw.startSec === "number") {
            chapters.push({ title: raw.title, startSec: raw.startSec });
        }
    }

    chapterData = { type: "player:chapters", videoId: data.videoId, chapters };
    ensureChapterTicks();
}

window.addEventListener("message", onChaptersMessage);

const playerTimeInterval = window.setInterval(() => {
    if (currentVideoId() === null) {
        return;
    }

    ensurePlayerObserver();
    ensureChapterTicks();
    const video = findVideoEl();

    if (!video) {
        return;
    }

    lastPlayerTime = video.currentTime;
    ticks?.setCurrentTime(lastPlayerTime);
    const message: PlayerTimeMessage = { type: "player:time", t: lastPlayerTime };
    window.postMessage(message, "https://www.youtube.com");
}, 1000);

scheduleMount();
window.addEventListener("yt-navigate-finish", scheduleMount);
window.addEventListener("popstate", scheduleMount);

window.__genesisYtCleanup = () => {
    removeSidePanel();
    window.removeEventListener("yt-navigate-finish", scheduleMount);
    window.removeEventListener("popstate", scheduleMount);
    window.removeEventListener("message", onChaptersMessage);
    window.clearInterval(playerTimeInterval);

    if (remountTimer !== null) {
        window.clearTimeout(remountTimer);
        remountTimer = null;
    }

    playerObserver?.disconnect();
    playerObserver = null;
    observedPlayer = null;
    unmountTicks();
};

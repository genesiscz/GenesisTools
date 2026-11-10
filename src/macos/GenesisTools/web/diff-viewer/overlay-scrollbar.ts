/**
 * GenesisKit's scroll bar for the diff page: the page's own vertical bar is hidden and a thin knob is drawn over the
 * right edge instead, shown while the page scrolls or the pointer is at that edge, so the code reaches the pane's edge
 * whatever System Settings says about scroll bars (Martin, 2026-11-10, annotation 2393: "it can be to the edge here").
 * The native app's lists draw the same knob (GenesisKit `GenScroller`). "system" gives the page back WebKit's bar.
 */

export type ScrollBarStyle = "genesis" | "system";

/** Width of the strip at the right edge that shows the bar under the pointer and takes its clicks. */
const EDGE = 11;
const MIN_KNOB = 28;
const HIDE_AFTER_MS = 900;

/** The knob's height and top inside a track of `track` px, or null when everything fits. */
export function knobGeometry(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    track: number
): { top: number; height: number } | null {
    if (scrollHeight <= clientHeight + 1 || track <= 0) {
        return null;
    }

    const height = Math.min(track, Math.max(MIN_KNOB, (clientHeight / scrollHeight) * track));
    const range = scrollHeight - clientHeight;
    const top = range > 0 ? (Math.min(Math.max(scrollTop, 0), range) / range) * (track - height) : 0;
    return { top, height };
}

export function installOverlayScrollbar(host: HTMLElement): { setStyle(style: ScrollBarStyle): void } {
    const root = document.documentElement;
    root.dataset.scrollbars = "genesis";

    const css = document.createElement("style");
    css.textContent = [
        `html[data-scrollbars="genesis"] #${host.id} { scrollbar-width: none; }`,
        `html[data-scrollbars="genesis"] #${host.id}::-webkit-scrollbar { display: none; width: 0; height: 0; }`,
        `.gen-scrollbar { position: fixed; width: ${EDGE}px; z-index: 30; opacity: 0; pointer-events: none; transition: opacity .25s ease; }`,
        ".gen-scrollbar.visible { opacity: 1; pointer-events: auto; }",
        'html[data-scrollbars="system"] .gen-scrollbar { display: none; }',
        ".gen-scrollbar-knob { position: absolute; right: 2px; width: 5px; border-radius: 4px; background: rgba(255,255,255,.32); transition: width .12s ease, background-color .12s ease; }",
        ".gen-scrollbar:hover .gen-scrollbar-knob, .gen-scrollbar.dragging .gen-scrollbar-knob { width: 7px; background: rgba(255,255,255,.5); }",
        "@media (prefers-color-scheme: light) { .gen-scrollbar-knob { background: rgba(0,0,0,.3); } .gen-scrollbar:hover .gen-scrollbar-knob, .gen-scrollbar.dragging .gen-scrollbar-knob { background: rgba(0,0,0,.45); } }",
    ].join("\n");
    document.head.appendChild(css);

    const track = document.createElement("div");
    track.className = "gen-scrollbar";
    track.setAttribute("aria-hidden", "true");
    const knob = document.createElement("div");
    knob.className = "gen-scrollbar-knob";
    track.appendChild(knob);
    document.body.appendChild(track);

    let hideTimer: number | undefined;
    let frame = 0;
    let atEdge = false;
    let drag: { startY: number; startTop: number; perPixel: number } | null = null;

    const geometry = () => {
        const rect = host.getBoundingClientRect();
        track.style.top = `${rect.top}px`;
        track.style.height = `${rect.height}px`;
        track.style.left = `${rect.right - EDGE}px`;
        return { rect, knob: knobGeometry(host.scrollTop, host.scrollHeight, host.clientHeight, rect.height) };
    };

    const draw = () => {
        frame = 0;
        const { knob: shape } = geometry();

        if (!shape) {
            track.classList.remove("visible");
            return;
        }

        knob.style.top = `${shape.top}px`;
        knob.style.height = `${shape.height}px`;
    };

    const show = () => {
        if (root.dataset.scrollbars !== "genesis") {
            return;
        }

        if (!frame) {
            frame = requestAnimationFrame(draw);
        }

        if (host.scrollHeight > host.clientHeight + 1) {
            track.classList.add("visible");
        }

        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => {
            if (!drag && !atEdge) {
                track.classList.remove("visible");
            }
        }, HIDE_AFTER_MS);
    };

    host.addEventListener("scroll", show, { passive: true });
    window.addEventListener("resize", () => {
        if (!frame) {
            frame = requestAnimationFrame(draw);
        }
    });
    // The bar also shows while the pointer is at the right edge, so it can be grabbed without scrolling first.
    document.addEventListener(
        "mousemove",
        (event) => {
            const rect = host.getBoundingClientRect();
            const near = event.clientX >= rect.right - EDGE && event.clientX <= rect.right && event.clientY >= rect.top;
            if (near !== atEdge) {
                atEdge = near;
                if (near) {
                    show();
                }
            }
        },
        { passive: true }
    );

    knob.addEventListener("pointerdown", (event) => {
        const { rect, knob: shape } = geometry();
        if (!shape) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const range = host.scrollHeight - host.clientHeight;
        drag = {
            startY: event.clientY,
            startTop: host.scrollTop,
            perPixel: range / Math.max(1, rect.height - shape.height),
        };
        knob.setPointerCapture(event.pointerId);
        track.classList.add("dragging");
    });
    knob.addEventListener("pointermove", (event) => {
        if (drag) {
            host.scrollTop = drag.startTop + (event.clientY - drag.startY) * drag.perPixel;
        }
    });
    const endDrag = (event: PointerEvent) => {
        if (!drag) {
            return;
        }

        drag = null;
        knob.releasePointerCapture(event.pointerId);
        track.classList.remove("dragging");
        show();
    };
    knob.addEventListener("pointerup", endDrag);
    knob.addEventListener("pointercancel", endDrag);
    // A click on the strip above or below the knob pages that way, as the system bar does.
    track.addEventListener("pointerdown", (event) => {
        if (event.target !== track) {
            return;
        }

        const knobRect = knob.getBoundingClientRect();
        const page = host.clientHeight * 0.9;
        host.scrollTop += event.clientY < knobRect.top ? -page : page;
    });

    return {
        setStyle(style) {
            root.dataset.scrollbars = style;
            if (style === "system") {
                track.classList.remove("visible");
            }
        },
    };
}

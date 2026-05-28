const TTYD_MOBILE_VIEWPORT =
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

const TTYD_MOBILE_SHELL_STYLE = `<style id="dd-ttyd-mobile-shell">
html, body {
    height: 100%;
    width: 100%;
    margin: 0;
    overflow: hidden;
    overscroll-behavior: none;
    touch-action: auto;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
}
#terminal, .terminal, .xterm {
    height: 100% !important;
    width: 100% !important;
    max-height: 100% !important;
    max-width: 100% !important;
}
.xterm-viewport {
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: none;
}
.xterm-screen, .xterm-screen canvas {
    touch-action: none;
}
</style>`;

const TTYD_MOBILE_SHELL_SCRIPT = `<script id="dd-ttyd-mobile-shell-js">
(function () {
    var pendingScroll = [];
    var touchAttached = false;

    function getTerm() {
        return window.term;
    }

    function lineHeight() {
        var row = document.querySelector(".xterm-rows > div");
        if (!row) {
            return 17;
        }

        var measured = row.getBoundingClientRect().height;
        return measured > 4 ? measured : 17;
    }

    function activeBufferType() {
        var term = getTerm();
        var buf = term && term.buffer && term.buffer.active;
        return buf && buf.type ? buf.type : null;
    }

    function applyScrollLines(lines) {
        var term = getTerm();
        if (!term || !term.scrollLines || !lines) {
            return false;
        }

        if (activeBufferType() === "alternate") {
            return false;
        }

        term.scrollLines.call(term, lines);
        return true;
    }

    function scrollViaMouseWheel(lines) {
        var term = getTerm();
        if (!term || !lines) {
            return false;
        }

        var core = term._core;
        var cms = core && core.coreMouseService;
        if (!cms || typeof cms.triggerMouseEvent !== "function" || !cms.areMouseEventsActive) {
            return false;
        }

        var steps = Math.max(1, Math.abs(Math.trunc(lines)));
        var button = lines < 0 ? 4 : 3;
        var col = Math.max(1, Math.floor(term.cols / 2));
        var row = Math.max(1, Math.floor(term.rows / 2));
        var lh = lineHeight();

        for (var i = 0; i < steps; i++) {
            cms.triggerMouseEvent({
                col: col,
                row: row,
                x: col * lh,
                y: row * lh,
                button: button,
                action: 0,
                ctrl: false,
                alt: false,
                shift: false
            });
        }

        return true;
    }

    function scrollViaWheel(lines) {
        var viewport = document.querySelector(".xterm-viewport");
        if (!viewport || !lines) {
            return false;
        }

        var linePx = lineHeight();
        return viewport.dispatchEvent(new WheelEvent("wheel", {
            deltaY: lines * linePx,
            deltaMode: 0,
            bubbles: true,
            cancelable: true
        }));
    }

    window.__ddTtydScroll = function (lines) {
        if (!lines) {
            return false;
        }

        if (scrollViaMouseWheel(lines)) {
            return true;
        }

        if (applyScrollLines(lines)) {
            return true;
        }

        if (scrollViaWheel(lines)) {
            return true;
        }

        pendingScroll.push(lines);
        waitForTerm();
        return true;
    };

    function flushPendingScroll() {
        if (!getTerm()) {
            return false;
        }

        while (pendingScroll.length > 0) {
            window.__ddTtydScroll(pendingScroll.shift());
        }

        return true;
    }

    function waitForTerm() {
        if (flushPendingScroll()) {
            return;
        }

        window.setTimeout(waitForTerm, 50);
    }

    window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.type !== "dd-ttyd-scroll") {
            return;
        }

        var lines = Number(data.lines);
        if (!lines) {
            return;
        }

        window.__ddTtydScroll(lines);
    });

    function attachTouchScroll() {
        if (touchAttached) {
            return;
        }

        var term = getTerm();
        var root = document.querySelector(".xterm") || document.querySelector("#terminal") || document.body;

        if (!term || !root) {
            return;
        }

        touchAttached = true;

        var active = false;
        var lastY = 0;
        var accum = 0;
        var linePx = lineHeight();

        function onTouchStart(event) {
            if (event.touches.length !== 1) {
                return;
            }

            active = true;
            lastY = event.touches[0].clientY;
            accum = 0;
            linePx = lineHeight();
        }

        function onTouchMove(event) {
            if (!active || event.touches.length !== 1) {
                return;
            }

            var y = event.touches[0].clientY;
            var dy = lastY - y;
            lastY = y;
            accum += dy;

            var lines = Math.trunc(accum / linePx);
            if (lines === 0) {
                return;
            }

            event.preventDefault();
            window.__ddTtydScroll(lines);
            accum -= lines * linePx;
        }

        function onTouchEnd() {
            active = false;
            accum = 0;
        }

        root.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
        root.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
        root.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
        root.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });
    }

    function boot() {
        attachTouchScroll();
        flushPendingScroll();

        if (!touchAttached) {
            window.setTimeout(boot, 50);
        }
    }

    document.addEventListener("gesturestart", function (event) { event.preventDefault(); }, { passive: false });
    document.addEventListener("gesturechange", function (event) { event.preventDefault(); }, { passive: false });
    document.addEventListener("gestureend", function (event) { event.preventDefault(); }, { passive: false });

    boot();
})();
</script>`;

export function shouldInjectTtydMobileShell(pathname: string, contentType: string | null): boolean {
    if (!/^\/ttyd\/[0-9a-fA-F-]{36}(?:\/|$)/.test(pathname)) {
        return false;
    }

    if (!contentType?.toLowerCase().includes("text/html")) {
        return false;
    }

    return true;
}

export function injectTtydMobileShell(html: string): string {
    const viewportMeta = `<meta name="viewport" content="${TTYD_MOBILE_VIEWPORT}">`;
    let out = html.replace(/<meta[^>]*name=["']viewport["'][^>]*>/i, viewportMeta);

    if (!out.includes('name="viewport"')) {
        out = out.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${viewportMeta}`);
    }

    if (!out.includes('id="dd-ttyd-mobile-shell"')) {
        out = out.replace(/<\/head>/i, `${TTYD_MOBILE_SHELL_STYLE}${TTYD_MOBILE_SHELL_SCRIPT}</head>`);
    }

    return out;
}

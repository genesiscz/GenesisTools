const TTYD_MOBILE_VIEWPORT =
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

const TTYD_MOBILE_SHELL_STYLE = `<style id="dd-ttyd-mobile-shell">
html {
    height: 100%;
    width: 100%;
    margin: 0;
    overflow: hidden;
    overscroll-behavior: none;
    touch-action: manipulation;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
}
body {
    height: 100%;
    width: 100%;
    margin: 0;
    overflow: hidden;
    overscroll-behavior: none;
    touch-action: none;
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
    touch-action: pan-y;
}
.xterm-screen {
    touch-action: pan-y;
}
</style>`;

const TTYD_MOBILE_SHELL_SCRIPT = `<script id="dd-ttyd-mobile-shell-js">
(function () {
    for (var i = 0; i < document.styleSheets.length; i += 1) {
        try {
            document.styleSheets[i].insertRule("* { -webkit-tap-highlight-color: transparent; }", 0);
            break;
        } catch (_err) {}
    }

    document.addEventListener("gesturestart", function (event) { event.preventDefault(); }, { passive: false });
    document.addEventListener("gesturechange", function (event) { event.preventDefault(); }, { passive: false });
    document.addEventListener("gestureend", function (event) { event.preventDefault(); }, { passive: false });

    function lineHeight() {
        var row = document.querySelector(".xterm-rows > div");
        if (!row) {
            return 17;
        }

        var measured = row.getBoundingClientRect().height;
        return measured > 4 ? measured : 17;
    }

    function attachTouchScroll() {
        var term = window.term;
        var surface = document.querySelector(".xterm-screen") || document.querySelector(".xterm");

        if (!term || !term.scrollLines || !surface) {
            window.setTimeout(attachTouchScroll, 80);
            return;
        }

        var active = false;
        var lastY = 0;
        var accum = 0;
        var linePx = lineHeight();

        surface.addEventListener("touchstart", function (event) {
            if (event.touches.length !== 1) {
                return;
            }

            active = true;
            lastY = event.touches[0].clientY;
            accum = 0;
            linePx = lineHeight();
        }, { passive: true });

        surface.addEventListener("touchmove", function (event) {
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

            term.scrollLines(lines);
            accum -= lines * linePx;
        }, { passive: true });

        surface.addEventListener("touchend", function () {
            active = false;
            accum = 0;
        }, { passive: true });

        surface.addEventListener("touchcancel", function () {
            active = false;
            accum = 0;
        }, { passive: true });
    }

    attachTouchScroll();
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

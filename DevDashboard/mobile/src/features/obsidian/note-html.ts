import { SafeJSON } from "@app/utils/json";

/**
 * The heart of the WebView renderer decision (path (a)): the server gives us a `<body>`-fragment
 * `html` (the SAME string the web mirror feeds `dangerouslySetInnerHTML`). We wrap it into a full HTML
 * document with (a) the dark "Obsidian Terminal" theme CSS so it matches the app (emerald palette,
 * mirroring `src/theme/colors.ts`), (b) the CLIENT assets that html depends on — highlight.js theme
 * CSS (always), KaTeX CSS (when math present), the mermaid ESM module + init (when a mermaid block is
 * present) — mirroring `src/dev-dashboard/lib/obsidian/share-template.ts`, and (c) a bridge script
 * that posts a JSON message to native when the user taps a `data-obsidian-note` wikilink or an
 * external link. No native markdown re-parse → KaTeX/mermaid/highlight/callouts render identically.
 *
 * Caveat (CDN dependency): the three asset bundles load from jsDelivr, so a fully-offline device shows
 * raw math/mermaid/monochrome code — acceptable for v1 (parity with the share page, which also uses
 * the CDN). A later task can self-host them on the Agent and point at `<baseUrl>/assets/...`.
 */

export type NoteMessage =
    | { type: "note"; path: string }
    | { type: "external"; url: string };

// Emerald "Obsidian Terminal" palette — mirrors src/theme/colors.ts / tokens.css 1:1 (NOT the blue
// values in the original stale plan). Skia/RN can't reach this string, so the hex is inlined here.
const THEME_CSS = `
:root {
    --dd-bg: #0c0e10;
    --dd-panel: #101316;
    --dd-text-primary: #e6edf3;
    --dd-text-secondary: #8b96a0;
    --dd-text-muted: #5b6670;
    --dd-border: #1e2428;
    --dd-accent: #34d399;
    --dd-danger: #f87171;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body {
    margin: 0;
    padding: 0;
    background: var(--dd-bg);
    color: var(--dd-text-primary);
    font: 16px/1.65 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
}
.dd-note-root { padding: 16px 18px 64px; max-width: 760px; margin: 0 auto; word-wrap: break-word; overflow-wrap: anywhere; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
h1 { font-size: 1.7em; }
h2 { font-size: 1.4em; border-bottom: 1px solid var(--dd-border); padding-bottom: 0.2em; }
a { color: var(--dd-accent); text-decoration: none; }
a:active { opacity: 0.7; }
.dd-wikilink { color: var(--dd-accent); }
.dd-wikilink-unresolved { color: var(--dd-text-muted); cursor: default; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
code { background: var(--dd-panel); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--dd-panel); padding: 12px 14px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--dd-border); }
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; border-radius: 8px; }
blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid var(--dd-border); color: var(--dd-text-secondary); }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--dd-border); padding: 6px 10px; }
hr { border: none; border-top: 1px solid var(--dd-border); margin: 2em 0; }
.markdown-alert { border-left: 3px solid var(--dd-border); border-radius: 6px; padding: 8px 14px; margin: 1em 0; background: rgba(255,255,255,0.03); }
.markdown-alert-title { display: flex; align-items: center; gap: 6px; font-weight: 600; margin: 0 0 0.4em; }
.dd-md-tag, .dd-md-inline-tag { display: inline-block; background: var(--dd-panel); border: 1px solid var(--dd-border); border-radius: 999px; padding: 0 8px; font-size: 0.8em; color: var(--dd-text-secondary); }
.katex { font-size: 1em; color: var(--dd-text-primary); }
.katex-display { margin: 1.2em 0; overflow-x: auto; overflow-y: hidden; }
.mermaid { background: var(--dd-panel); border: 1px solid var(--dd-border); border-radius: 8px; padding: 12px; overflow-x: auto; }
`;

// Asset URLs + SRI copied verbatim from src/dev-dashboard/lib/obsidian/share-template.ts.
// KEEP IN SYNC with that file (a later task can export them from a shared const module).
const HLJS_CSS_URL = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-dark.min.css";
const HLJS_CSS_SRI = "sha384-oaMLBGEzBOJx3UHwac0cVndtX5fxGQIfnAeFZ35RTgqPcYlbprH9o9PUV/F8Le07";
const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
const KATEX_CSS_SRI = "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+";
const MERMAID_JS_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";

// Mermaid theme tuned to the emerald palette (accent #34d399, panel #101316, base #0c0e10).
const MERMAID_SCRIPT = `
<script type="module">
import mermaid from "${MERMAID_JS_URL}";
mermaid.initialize({
    startOnLoad: true,
    theme: "dark",
    themeVariables: {
        background: "#101316",
        primaryColor: "#101316",
        primaryTextColor: "#e6edf3",
        primaryBorderColor: "#34d399",
        lineColor: "#5b6670",
        secondaryColor: "#0c0e10",
        tertiaryColor: "#0c0e10",
        nodeBorder: "#34d399",
        clusterBkg: "#101316",
        clusterBorder: "#1e2428"
    },
    securityLevel: "strict"
});
</script>`;

/** Same heuristic the server (`renderMarkdown`) uses internally to detect math/mermaid. */
function htmlHasMath(html: string): boolean {
    return /class="katex(?:[ "])/.test(html);
}

function htmlHasMermaid(html: string): boolean {
    return html.includes('<div class="mermaid"');
}

// Runs INSIDE the WebView's JS engine (browser context), so the global browser `JSON` is correct
// here — `@app/utils/json`/SafeJSON is a native-module construct not available in the page.
const BRIDGE_SCRIPT = `
(function () {
    function post(payload) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
    }
    document.addEventListener("click", function (event) {
        var el = event.target;
        while (el && el !== document.body) {
            if (el.tagName === "A") {
                var note = el.getAttribute("data-obsidian-note");
                if (note) {
                    event.preventDefault();
                    post({ type: "note", path: note });
                    return;
                }
                var href = el.getAttribute("href") || "";
                if (/^https?:/i.test(href)) {
                    event.preventDefault();
                    post({ type: "external", url: href });
                    return;
                }
            }
            el = el.parentElement;
        }
    }, true);
})();
`;

export function buildNoteDocument(bodyHtml: string): string {
    const head: string[] = [
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
        '<meta name="referrer" content="no-referrer" />',
        // hljs theme is always loaded (code blocks are common; monochrome without it):
        `<link rel="stylesheet" href="${HLJS_CSS_URL}" integrity="${HLJS_CSS_SRI}" crossorigin="anonymous" />`,
        `<style>${THEME_CSS}</style>`,
        // bridge MUST precede the body so body content can never terminate it:
        `<script>${BRIDGE_SCRIPT}</script>`,
    ];

    if (htmlHasMath(bodyHtml)) {
        head.splice(
            3,
            0,
            `<link rel="stylesheet" href="${KATEX_CSS_URL}" integrity="${KATEX_CSS_SRI}" crossorigin="anonymous" />`,
        );
    }

    const body: string[] = [`<div class="dd-note-root">${bodyHtml}</div>`];

    if (htmlHasMermaid(bodyHtml)) {
        body.push(MERMAID_SCRIPT);
    }

    return [
        "<!doctype html>",
        '<html lang="en"><head>',
        head.join(""),
        "</head><body>",
        body.join(""),
        "</body></html>",
    ].join("");
}

export function parseNoteMessage(raw: string): NoteMessage | null {
    let data: unknown;

    try {
        data = SafeJSON.parse(raw, { strict: true });
    } catch {
        return null;
    }

    if (typeof data !== "object" || data === null) {
        return null;
    }

    const obj = data as Record<string, unknown>;

    if (obj.type === "note" && typeof obj.path === "string" && obj.path.length > 0) {
        return { type: "note", path: obj.path };
    }

    if (obj.type === "external" && typeof obj.url === "string" && obj.url.length > 0) {
        return { type: "external", url: obj.url };
    }

    return null;
}

export function shareUrl(baseUrl: string, slug: string | null): string | null {
    if (!slug) {
        return null;
    }

    return `${baseUrl.replace(/\/$/, "")}/share/${slug}`;
}

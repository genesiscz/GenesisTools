import type { RenderResult } from "@app/dev-dashboard/lib/obsidian/markdown";
import { codeLanguageFor } from "@app/dev-dashboard/lib/obsidian/share-assets";
import { SafeJSON } from "@genesiscz/utils/json";
import { escapeHtml } from "@genesiscz/utils/string";

interface ShareTemplateOptions {
    title: string;
    rendered: RenderResult;
    source: string;
    sourcePath?: string;
    /** A JSON asset URL whose side panel opens on load (a deep link to `?asset=<hash>`). */
    openAssetUrl?: string;
}

const HLJS_CSS_URL = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-dark.min.css";
const HLJS_CSS_SRI = "sha384-oaMLBGEzBOJx3UHwac0cVndtX5fxGQIfnAeFZ35RTgqPcYlbprH9o9PUV/F8Le07";
const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
const KATEX_CSS_SRI = "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+";
const MERMAID_JS_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";
// SRI for the Mermaid ESM entry. Update whenever MERMAID_JS_URL's version
// changes (regenerate via `openssl dgst -sha384 -binary <file> | openssl base64
// -A`). Covers the ~28 KB entry only; lazy-loaded diagram chunks ship from the
// same CDN unprotected — a full seal needs self-hosting.
const MERMAID_JS_SRI = "sha384-whY2DyvhZRFfs9hvtGdZaKcgbETgqMlDN+KNlWnXEL2QDa2XQkBOApUT7arfftO9";
const INTER_FONT_URL =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Lora:ital,wght@0,400;0,600;1,400&display=swap";

function buildCss(): string {
    return `
:root {
    color-scheme: dark;
    --dd-bg: #0c0e10;
    --dd-bg-panel: #101316;
    --dd-bg-elevated: #161b20;
    --dd-border: #1e2428;
    --dd-border-strong: #2a3439;
    --dd-text: #e6edf3;
    --dd-text-dim: #8b96a0;
    --dd-text-faint: #5b6670;
    --dd-accent: #34d399;
    --dd-accent-2: #2dd4bf;
    --dd-accent-soft: rgba(52, 211, 153, 0.12);
    --dd-link: #5eead4;
    --dd-tag-bg: rgba(52, 211, 153, 0.1);
    --dd-tag-text: #5eead4;
    --dd-serif: "Lora", Georgia, "Iowan Old Style", "Palatino Linotype", serif;
    --dd-sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
    --dd-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html, body {
    margin: 0;
    padding: 0;
    background: var(--dd-bg);
    color: var(--dd-text);
    font-family: var(--dd-sans);
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

body {
    padding: 56px 24px 96px;
    background-image:
        radial-gradient(ellipse 1200px 600px at 50% -200px, rgba(52, 211, 153, 0.06), transparent 60%),
        var(--dd-bg);
}

main {
    max-width: 780px;
    margin: 0 auto;
}

article {
    font-family: var(--dd-sans);
    font-size: 16.5px;
    color: var(--dd-text);
}

article > * + * { margin-top: 1.1em; }

h1, h2, h3, h4, h5, h6 {
    font-family: var(--dd-sans);
    color: var(--dd-text);
    line-height: 1.25;
    margin: 1.6em 0 0.6em;
    font-weight: 600;
}

h1 {
    font-size: 2.1em;
    border-bottom: 1px solid var(--dd-border);
    padding-bottom: 0.3em;
    margin-top: 0;
    letter-spacing: -0.01em;
}

h2 {
    font-size: 1.55em;
    border-bottom: 1px solid var(--dd-border);
    padding-bottom: 0.25em;
    letter-spacing: -0.01em;
}

h3 { font-size: 1.25em; }
h4 { font-size: 1.1em; color: var(--dd-text-dim); }

p { margin: 0.8em 0; }

a {
    color: var(--dd-link);
    text-decoration: none;
    border-bottom: 1px solid rgba(94, 234, 212, 0.3);
    transition: border-color 0.15s, color 0.15s;
}

a:hover {
    color: var(--dd-accent);
    border-bottom-color: var(--dd-accent);
}

strong { color: #f4f8fb; font-weight: 600; }
em { color: var(--dd-text); }
hr { border: 0; border-top: 1px solid var(--dd-border); margin: 2em 0; }

ul, ol { padding-left: 1.6em; margin: 0.8em 0; }
li { margin: 0.25em 0; }
li > p { margin: 0.25em 0; }

ul li::marker { color: var(--dd-text-faint); }
ol li::marker { color: var(--dd-text-faint); }

article input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border: 1.5px solid var(--dd-border-strong);
    border-radius: 4px;
    background: var(--dd-bg-panel);
    margin-right: 8px;
    margin-left: -1.4em;
    vertical-align: -3px;
    position: relative;
    cursor: default;
}

article input[type="checkbox"]:checked {
    background: var(--dd-accent);
    border-color: var(--dd-accent);
}

article input[type="checkbox"]:checked::after {
    content: "✓";
    color: var(--dd-bg);
    font-size: 12px;
    font-weight: 700;
    position: absolute;
    top: -3px;
    left: 2px;
}

article ul li.task-list-item {
    list-style: none;
    margin-left: -1.4em;
}

blockquote {
    margin: 1em 0;
    padding: 0.6em 1.1em;
    border-left: 3px solid var(--dd-border-strong);
    background: rgba(255, 255, 255, 0.015);
    color: var(--dd-text-dim);
    border-radius: 0 4px 4px 0;
    font-style: italic;
}

blockquote > * { margin: 0.4em 0; }

code {
    font-family: var(--dd-mono);
    font-size: 0.88em;
    background: var(--dd-bg-elevated);
    border: 1px solid var(--dd-border);
    border-radius: 5px;
    padding: 1px 6px;
    color: #f4f8fb;
}

pre {
    margin: 1.2em 0;
    padding: 0;
    background: #0a0c0f;
    border: 1px solid var(--dd-border);
    border-radius: 8px;
    overflow: auto;
    font-family: var(--dd-mono);
    font-size: 13.5px;
    line-height: 1.55;
}

pre code, pre code.hljs {
    display: block;
    padding: 14px 16px;
    background: transparent;
    border: 0;
    border-radius: 0;
    color: #e6edf3;
    font-size: inherit;
}

table {
    border-collapse: collapse;
    margin: 1.2em 0;
    width: 100%;
    font-size: 0.95em;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid var(--dd-border);
}

thead { background: var(--dd-bg-panel); }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--dd-border); }
th { color: var(--dd-text); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.015); }

img { max-width: 100%; height: auto; border-radius: 6px; }

.dd-md-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 1.6em;
}

.dd-md-tag, .dd-md-inline-tag {
    display: inline-block;
    background: var(--dd-tag-bg);
    color: var(--dd-tag-text);
    border: 1px solid rgba(94, 234, 212, 0.18);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.78em;
    font-family: var(--dd-sans);
    font-weight: 500;
    letter-spacing: 0.01em;
    line-height: 1.5;
}

.dd-md-inline-tag {
    padding: 0px 8px;
    font-size: 0.82em;
    vertical-align: 1px;
}

.dd-wikilink {
    color: var(--dd-link);
    text-decoration: none;
    border-bottom: 1px dashed rgba(94, 234, 212, 0.4);
    padding-bottom: 1px;
}

.dd-wikilink:hover {
    color: var(--dd-accent);
    border-bottom-color: var(--dd-accent);
}

.dd-wikilink-unresolved {
    color: var(--dd-text-faint);
    border-bottom: 1px dotted var(--dd-text-faint);
    cursor: not-allowed;
}

.dd-md-embed-stub {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    background: var(--dd-bg-panel);
    border: 1px dashed var(--dd-border-strong);
    border-radius: 6px;
    padding: 4px 10px;
    color: var(--dd-text-dim);
    font-size: 0.9em;
}

.dd-md-embed-icon { color: var(--dd-accent); }
.dd-md-embed-label { font-family: var(--dd-mono); }

.dd-md-asset-img {
    display: block;
    margin: 0.4em 0;
    border: 1px solid var(--dd-border);
    background: var(--dd-bg-panel);
}

.dd-md-asset-link { color: var(--dd-link); }

.dd-md-asset-chip {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    max-width: 100%;
    background: var(--dd-bg-panel);
    border: 1px solid var(--dd-border-strong);
    border-radius: 6px;
    padding: 2px 10px;
    color: var(--dd-text);
    font-family: var(--dd-mono);
    font-size: 0.84em;
    text-decoration: none;
    overflow-wrap: anywhere;
    transition: border-color 0.15s, background 0.15s;
}

.dd-md-asset-chip:hover {
    border-color: var(--dd-accent);
    background: var(--dd-accent-soft);
}

.dd-md-asset-chip-icon { color: var(--dd-accent); font-weight: 600; }

.dd-md-inert-link { color: var(--dd-text-dim); border-bottom: 1px dotted var(--dd-text-faint); }

.dd-line-hit { background: rgba(52, 211, 153, 0.14); box-shadow: inset 3px 0 0 var(--dd-accent); }
.dd-src-block { border-radius: 6px; padding: 0 8px; margin: 0 -8px; }
.dd-src-block > :first-child { margin-top: 0.6em; }

.dd-code-window { margin: 0 0 8px; font-size: 12px; color: var(--dd-text-faint); font-family: var(--dd-mono); }
pre.dd-code-lines code { padding: 10px 0; }
.dd-code-line { display: block; padding: 0 14px 0 0; }
.dd-code-ln {
    display: inline-block;
    width: 3.2em;
    padding-right: 1em;
    margin-right: 0.6em;
    text-align: right;
    color: var(--dd-text-faint);
    border-right: 1px solid var(--dd-border);
    user-select: none;
}

.dd-share-panel-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s;
    z-index: 110;
}

.dd-share-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(640px, 94vw);
    display: flex;
    flex-direction: column;
    background: var(--dd-bg-panel);
    border-left: 1px solid var(--dd-border-strong);
    box-shadow: -24px 0 48px rgba(0, 0, 0, 0.45);
    transform: translateX(100%);
    transition: transform 0.2s ease;
    z-index: 111;
}

body.dd-share-panel-open .dd-share-panel-backdrop { opacity: 1; pointer-events: auto; }
body.dd-share-panel-open .dd-share-panel { transform: none; }

.dd-share-panel-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--dd-border);
}

.dd-share-panel-title {
    flex: 1;
    min-width: 0;
    font-family: var(--dd-mono);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dd-share-panel-head a, .dd-share-panel-head button {
    color: var(--dd-text-dim);
    background: none;
    border: 1px solid var(--dd-border-strong);
    border-radius: 6px;
    padding: 2px 10px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
}

.dd-share-panel-head a:hover, .dd-share-panel-head button:hover { color: var(--dd-accent); border-color: var(--dd-accent); }

.dd-share-panel-body {
    flex: 1;
    overflow: auto;
    padding: 12px 16px 24px;
}

.dd-share-panel-body pre { margin: 0; }
.dd-share-panel-body pre code { white-space: pre-wrap; overflow-wrap: anywhere; }
.dd-share-panel-body .dd-code-line { padding-left: 4.4em; text-indent: -4.4em; }

.markdown-alert {
    --cal: var(--dd-border-strong);
    margin: 1.2em 0;
    padding: 12px 16px 4px;
    border: 1px solid color-mix(in srgb, var(--cal) 28%, transparent);
    border-left: 4px solid var(--cal);
    border-radius: 0 8px 8px 0;
    background: color-mix(in srgb, var(--cal) 8%, var(--dd-bg-panel));
}

.markdown-alert-body > * { margin: 0.55em 0; }
.markdown-alert-body > :first-child { margin-top: 0; }
.markdown-alert-body > :last-child { margin-bottom: 0.4em; }
.markdown-alert:not(:has(.markdown-alert-body)) { padding-bottom: 12px; }

.markdown-alert-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 0.97em;
    margin: 0 0 8px;
    color: var(--cal);
    line-height: 1.4;
}

.markdown-alert-title code { color: inherit; }

.markdown-alert-icon {
    flex: none;
    width: 17px;
    height: 17px;
    color: var(--cal);
}

.markdown-alert-note { --cal: #4493f8; }
.markdown-alert-abstract { --cal: #22d3ee; }
.markdown-alert-info { --cal: #4493f8; }
.markdown-alert-todo { --cal: #38bdf8; }
.markdown-alert-tip { --cal: var(--dd-accent-2, #2dd4bf); }
.markdown-alert-success { --cal: var(--dd-accent, #34d399); }
.markdown-alert-question { --cal: #eab308; }
.markdown-alert-warning { --cal: #f59e0b; }
.markdown-alert-failure { --cal: #f87171; }
.markdown-alert-danger { --cal: #ef4444; }
.markdown-alert-bug { --cal: #fb7185; }
.markdown-alert-example { --cal: #a855f7; }
.markdown-alert-quote { --cal: var(--dd-text-dim); }

.mermaid {
    background: var(--dd-bg-panel);
    border: 1px solid var(--dd-border);
    border-radius: 8px;
    padding: 16px;
    margin: 1.2em 0;
    text-align: center;
    color: var(--dd-text-dim);
    font-family: var(--dd-mono);
    font-size: 0.85em;
}

.katex { color: var(--dd-text); font-size: 1em; }
.katex-display { margin: 1.2em 0; overflow-x: auto; overflow-y: hidden; }

footer.dd-share-footer {
    margin-top: 64px;
    padding-top: 16px;
    border-top: 1px solid var(--dd-border);
    font-size: 11px;
    color: var(--dd-text-faint);
    text-align: center;
    font-family: var(--dd-mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

footer.dd-share-footer .dd-share-source {
    display: block;
    margin-top: 6px;
    color: var(--dd-text-faint);
    text-transform: none;
    letter-spacing: 0;
    font-size: 11px;
    word-break: break-all;
}

.dd-share-toolbar {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 100;
    display: flex;
    gap: 8px;
}

.dd-share-view-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--dd-border-strong);
    border-radius: 8px;
    background: var(--dd-bg-elevated);
    color: var(--dd-text-dim);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.dd-share-view-btn:hover {
    color: var(--dd-accent);
    border-color: var(--dd-accent);
    background: var(--dd-accent-soft);
}

.dd-share-view-btn svg {
    width: 18px;
    height: 18px;
}

.dd-share-source-panel {
    display: none;
    font-family: var(--dd-mono);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--dd-text);
    background: var(--dd-bg-panel);
    border: 1px solid var(--dd-border);
    border-radius: 8px;
    padding: 16px 20px;
    overflow-x: auto;
    margin: 0;
}

body.dd-share-mode-source article {
    display: none;
}

body.dd-share-mode-source .dd-share-source-panel {
    display: block;
}

@media (max-width: 600px) {
    body { padding: 28px 16px 64px; }
    article { font-size: 16px; }
    h1 { font-size: 1.8em; }
    h2 { font-size: 1.4em; }
    pre { font-size: 13px; }
}
`;
}

function buildMermaidScript(): string {
    return `
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
        secondaryColor: "#161b20",
        tertiaryColor: "#0c0e10",
        nodeBorder: "#34d399",
        clusterBkg: "#101316",
        clusterBorder: "#1e2428"
    },
    securityLevel: "strict"
});
</script>`;
}

const FILE_CODE_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/></svg>';

const BOOK_OPEN_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';

const DOWNLOAD_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';

function embedSourceJson(source: string): string {
    return SafeJSON.stringify(source).replace(/</g, "\\u003c");
}

interface ShareLabels {
    showRaw: string;
    showRendered: string;
    download: string;
}

const NOTE_LABELS: ShareLabels = {
    showRaw: "Show raw markdown source",
    showRendered: "Show rendered note",
    download: "Download raw markdown",
};

const SOURCE_FILE_LABELS: ShareLabels = {
    showRaw: "Show raw source",
    showRendered: "Show highlighted source",
    download: "Download source file",
};

function buildViewToggleScript({
    downloadName,
    contentType,
    labels,
}: {
    downloadName: string;
    contentType: string;
    labels: ShareLabels;
}): string {
    return `<script>
(function () {
    var btn = document.getElementById("dd-share-view-btn");
    var panel = document.getElementById("dd-share-source-panel");
    var dataEl = document.getElementById("dd-share-source-data");
    if (!btn || !panel || !dataEl) {
        return;
    }

    panel.textContent = JSON.parse(dataEl.textContent);

    var downloadBtn = document.getElementById("dd-share-download-btn");
    if (downloadBtn) {
        downloadBtn.addEventListener("click", function () {
            var blob = new Blob([panel.textContent], { type: ${SafeJSON.stringify(contentType)} });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = ${SafeJSON.stringify(downloadName)};
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        });
    }

    var fileCodeIcon = ${SafeJSON.stringify(FILE_CODE_ICON)};
    var bookOpenIcon = ${SafeJSON.stringify(BOOK_OPEN_ICON)};
    var mode = "reading";

    btn.addEventListener("click", function () {
        mode = mode === "reading" ? "source" : "reading";
        document.body.classList.toggle("dd-share-mode-source", mode === "source");
        btn.innerHTML = mode === "reading" ? fileCodeIcon : bookOpenIcon;
        btn.setAttribute(
            "aria-label",
            mode === "reading" ? ${SafeJSON.stringify(labels.showRaw)} : ${SafeJSON.stringify(labels.showRendered)}
        );
        btn.title = btn.getAttribute("aria-label") ?? "";
    });
})();
</script>`;
}

function buildAssetPanelScript(): string {
    return `<script>
(function () {
    var panel = document.getElementById("dd-share-panel");
    var backdrop = document.getElementById("dd-share-panel-backdrop");
    var content = document.getElementById("dd-share-panel-body");
    var title = document.getElementById("dd-share-panel-title");
    var rawLink = document.getElementById("dd-share-panel-raw");
    var closeBtn = document.getElementById("dd-share-panel-close");
    if (!panel || !backdrop || !content || !title || !rawLink || !closeBtn) {
        return;
    }

    var basePath = location.pathname;
    var lastFocus = null;
    var isOpen = false;
    // Each open asks for one fragment; an answer for an earlier open (or after a close) is dropped.
    var panelRequest = 0;
    // While the panel is open the page behind it is inert, so Tab stays inside the dialog.
    var behind = [document.querySelector(".dd-share-toolbar"), document.querySelector("main")];

    function setBehindInert(on) {
        for (var b = 0; b < behind.length; b++) {
            if (!behind[b]) {
                continue;
            }
            if (on) {
                behind[b].setAttribute("inert", "");
            } else {
                behind[b].removeAttribute("inert");
            }
        }
    }

    function nameFor(base) {
        var chips = document.querySelectorAll("a[data-asset-panel]");
        for (var i = 0; i < chips.length; i++) {
            if (chips[i].getAttribute("data-asset-panel") === base) {
                return chips[i].getAttribute("data-asset-name") || "file";
            }
        }
        return "file";
    }

    function parseLines(hash) {
        var match = /^#L(\\d+)(?:-L?(\\d+))?$/.exec(hash || "");
        if (!match) {
            return null;
        }
        var start = Number(match[1]);
        return { start: start, end: Math.max(start, Number(match[2] || start)) };
    }

    function markLines(lines) {
        if (!lines) {
            return;
        }

        var hits = [];
        var codeLines = content.querySelectorAll(".dd-code-line[data-line]");
        for (var i = 0; i < codeLines.length; i++) {
            var n = Number(codeLines[i].getAttribute("data-line"));
            if (n >= lines.start && n <= lines.end) {
                hits.push(codeLines[i]);
            }
        }

        var blocks = content.querySelectorAll(".dd-src-block[data-line-start]");
        for (var j = 0; j < blocks.length; j++) {
            var from = Number(blocks[j].getAttribute("data-line-start"));
            var to = Number(blocks[j].getAttribute("data-line-end"));
            if (from <= lines.end && to >= lines.start) {
                blocks[j].classList.add("dd-line-hit");
                hits.push(blocks[j]);
            }
        }

        if (hits.length > 0) {
            hits[0].scrollIntoView({ block: "center" });
        }
    }

    function openPanel(url, push) {
        var hashAt = url.indexOf("#");
        var base = hashAt === -1 ? url : url.slice(0, hashAt);
        var hash = hashAt === -1 ? "" : url.slice(hashAt);
        var lines = parseLines(hash);
        var name = nameFor(base);
        lastFocus = document.activeElement;
        title.textContent = lines ? name + ":" + lines.start + (lines.end > lines.start ? "-" + lines.end : "") : name;
        rawLink.href = base + "&view=raw";
        content.textContent = "Loading " + name + "\u2026";
        document.body.classList.add("dd-share-panel-open");
        panel.setAttribute("aria-hidden", "false");
        panel.removeAttribute("inert");
        setBehindInert(true);
        isOpen = true;
        var request = ++panelRequest;
        if (push) {
            history.pushState({ ddAsset: url }, "", url);
        }

        var fragmentUrl = base + "&view=fragment" + (lines ? "&lines=" + lines.start + "-" + lines.end : "");
        fetch(fragmentUrl, { headers: { Accept: "text/html" } })
            .then(function (res) {
                if (!res.ok) {
                    throw new Error("HTTP " + res.status);
                }
                return res.text();
            })
            .then(function (html) {
                if (request !== panelRequest) {
                    return;
                }
                content.innerHTML = html;
                content.scrollTop = 0;
                markLines(lines);
            })
            .catch(function (err) {
                if (request !== panelRequest) {
                    return;
                }
                content.textContent = "Could not load " + name + ": " + err.message;
            });
        closeBtn.focus();
    }

    function closePanel(push) {
        if (!isOpen) {
            return;
        }

        isOpen = false;
        panelRequest++;
        document.body.classList.remove("dd-share-panel-open");
        panel.setAttribute("aria-hidden", "true");
        panel.setAttribute("inert", "");
        setBehindInert(false);
        if (push) {
            history.pushState(null, "", basePath);
        }
        if (lastFocus && lastFocus.focus) {
            lastFocus.focus();
        }
    }

    document.addEventListener("click", function (event) {
        var chip = event.target && event.target.closest ? event.target.closest("a[data-asset-panel]") : null;
        if (!chip || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
        }

        event.preventDefault();
        openPanel(chip.getAttribute("href"), true);
    });
    closeBtn.addEventListener("click", function () { closePanel(true); });
    backdrop.addEventListener("click", function () { closePanel(true); });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
            closePanel(true);
        }
    });
    window.addEventListener("popstate", function (event) {
        if (event.state && event.state.ddAsset) {
            openPanel(event.state.ddAsset, false);
        } else {
            closePanel(false);
        }
    });

    var initial = document.body.getAttribute("data-open-asset");
    if (initial) {
        var deepLink = initial + location.hash;
        history.replaceState({ ddAsset: deepLink }, "", deepLink);
        openPanel(deepLink, false);
    }
})();
</script>`;
}

export function renderSharePage(options: ShareTemplateOptions): string {
    const { title, rendered, source, sourcePath, openAssetUrl } = options;
    const headExtras: string[] = [
        `<link rel="preconnect" href="https://fonts.googleapis.com">`,
        `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
        `<link rel="stylesheet" href="${INTER_FONT_URL}">`,
        `<link rel="stylesheet" href="${HLJS_CSS_URL}" integrity="${HLJS_CSS_SRI}" crossorigin="anonymous">`,
    ];

    if (rendered.hasMath) {
        headExtras.push(
            `<link rel="stylesheet" href="${KATEX_CSS_URL}" integrity="${KATEX_CSS_SRI}" crossorigin="anonymous">`
        );
    }

    if (rendered.hasMermaid) {
        headExtras.push(
            `<link rel="modulepreload" href="${MERMAID_JS_URL}" integrity="${MERMAID_JS_SRI}" crossorigin="anonymous">`
        );
    }

    const bodyExtras: string[] = [];

    if (rendered.hasMermaid) {
        bodyExtras.push(buildMermaidScript());
    }

    const fileName = sourcePath?.split("/").pop();
    // A shared source file downloads under its own name; only a note gets the .md suffix.
    const isSourceFile = Boolean(fileName && codeLanguageFor(fileName));
    const baseName = isSourceFile && fileName ? fileName : `${fileName?.replace(/\.md$/i, "") || title}.md`;
    const downloadName = baseName.replace(/[\\/:*?"<>|]/g, "_");
    const contentType = isSourceFile ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8";

    const labels = isSourceFile ? SOURCE_FILE_LABELS : NOTE_LABELS;

    bodyExtras.push(buildViewToggleScript({ downloadName, contentType, labels }));
    bodyExtras.push(buildAssetPanelScript());

    const sourceLine = sourcePath ? `<span class="dd-share-source">${escapeHtml(sourcePath)}</span>` : "";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${headExtras.join("\n")}
<style>${buildCss()}</style>
</head>
<body${openAssetUrl ? ` data-open-asset="${escapeHtml(openAssetUrl)}"` : ""}>
<div class="dd-share-toolbar">
<button type="button" class="dd-share-view-btn" id="dd-share-view-btn" aria-label="${escapeHtml(labels.showRaw)}" title="${escapeHtml(labels.showRaw)}">${FILE_CODE_ICON}</button>
<button type="button" class="dd-share-view-btn" id="dd-share-download-btn" aria-label="${escapeHtml(labels.download)}" title="${escapeHtml(labels.download)}">${DOWNLOAD_ICON}</button>
</div>
<main>
<article>${rendered.html}</article>
<pre class="dd-share-source-panel" id="dd-share-source-panel"></pre>
<footer class="dd-share-footer">shared via dev-dashboard${sourceLine}</footer>
</main>
<div class="dd-share-panel-backdrop" id="dd-share-panel-backdrop"></div>
<aside class="dd-share-panel" id="dd-share-panel" role="dialog" aria-modal="true" aria-labelledby="dd-share-panel-title" aria-hidden="true" inert>
<div class="dd-share-panel-head">
<span class="dd-share-panel-title" id="dd-share-panel-title"></span>
<a id="dd-share-panel-raw" href="#" target="_blank" rel="noopener">Raw</a>
<button type="button" id="dd-share-panel-close" aria-label="Close panel">Close</button>
</div>
<div class="dd-share-panel-body" id="dd-share-panel-body"></div>
</aside>
<script type="application/json" id="dd-share-source-data">${embedSourceJson(source)}</script>
${bodyExtras.join("\n")}
</body>
</html>`;
}

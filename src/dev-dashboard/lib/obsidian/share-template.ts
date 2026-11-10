import type { RenderResult } from "@app/dev-dashboard/lib/obsidian/markdown";
import type { OfflineShareAssets } from "@app/dev-dashboard/lib/obsidian/offline-assets";
import { codeLanguageFor, type ShareEmbedPanels } from "@app/dev-dashboard/lib/obsidian/share-assets";
import { SafeJSON } from "@genesiscz/utils/json";
import { escapeHtml } from "@genesiscz/utils/string";

interface ShareTemplateOptions {
    title: string;
    rendered: RenderResult;
    source: string;
    sourcePath?: string;
    /** A JSON asset URL whose side panel opens on load (a deep link to `?asset=<hash>`). */
    openAssetUrl?: string;
    /** How many files the note references; above zero the download menu offers a zip with them. */
    attachmentCount?: number;
    /** URLs of the note as a zip with its attachments and as one self-contained HTML file. */
    downloads?: { zip: string; html: string };
    /** A saved copy of the page: panel bodies by `embeddedPanelKey` and their raw files, read instead of fetched. */
    embeddedPanels?: ShareEmbedPanels;
    offlineAssets?: OfflineShareAssets;
    mermaidCode?: string;
}

const HLJS_CSS_URL = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-dark.min.css";
const HLJS_CSS_SRI = "sha384-oaMLBGEzBOJx3UHwac0cVndtX5fxGQIfnAeFZ35RTgqPcYlbprH9o9PUV/F8Le07";
const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
const KATEX_CSS_SRI = "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+";
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
    position: relative;
    max-width: var(--dd-share-width, 780px);
    margin: 0 auto;
}

/* The reading width, as in the Genesis Markdown viewer: drag a grip in the body
   padding on either side, double-click or Enter to reset. Each reader's width is
   kept in their own browser. */
.dd-share-grip {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 16px;
    cursor: col-resize;
    opacity: 0;
    touch-action: none;
    transition: opacity 150ms;
}

.dd-share-grip::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 6px;
    width: 3px;
    border-radius: 2px;
    background: var(--dd-border-strong, var(--dd-border));
}

.dd-share-grip-l { left: -22px; }
.dd-share-grip-r { right: -22px; }

main:hover > .dd-share-grip,
.dd-share-grip.dd-share-grip-active,
.dd-share-grip:focus-visible {
    opacity: 1;
}

.dd-share-grip:hover::after,
.dd-share-grip.dd-share-grip-active::after,
.dd-share-grip:focus-visible::after {
    background: var(--dd-accent);
}

.dd-share-grip:focus-visible { outline: none; }

body.dd-share-resizing {
    cursor: col-resize;
    user-select: none;
    -webkit-user-select: none;
}

@media (pointer: coarse) {
    .dd-share-grip { display: none; }
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

img { max-width: 100%; height: auto; border-radius: 6px; object-fit: contain; }

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

details.markdown-alert:not([open]) { padding-bottom: 4px; }
details.markdown-alert > summary.markdown-alert-title { cursor: pointer; list-style: none; }
details.markdown-alert > summary.markdown-alert-title::-webkit-details-marker { display: none; }
details.markdown-alert > summary.markdown-alert-title::after {
    content: "";
    width: 7px;
    height: 7px;
    margin-left: 2px;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(-45deg);
    transition: transform 0.15s;
}
details.markdown-alert[open] > summary.markdown-alert-title::after { transform: rotate(45deg); }

mark {
    padding: 0 2px;
    border-radius: 3px;
    background: color-mix(in srgb, #facc15 32%, transparent);
    color: inherit;
}

kbd {
    padding: 1px 6px;
    border: 1px solid var(--dd-border-strong);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--dd-bg-panel);
    font-family: var(--dd-mono);
    font-size: 0.85em;
}

li:has(> input[data-task]), li:has(> p > input[data-task]) { list-style: none; }
input[data-task] { accent-color: var(--dd-text-faint); }

.dd-md-asset-audio { display: block; width: 100%; max-width: 520px; margin: 0.5em 0; }
.dd-md-asset-video { display: block; max-width: 100%; height: auto; margin: 0.5em 0; border-radius: 6px; background: #000; }
.dd-md-asset-pdf {
    display: block;
    width: 100%;
    height: 720px;
    margin: 0.5em 0;
    border: 1px solid var(--dd-border);
    border-radius: 6px;
    background: var(--dd-bg-panel);
}

.dd-md-transclusion {
    margin: 1em 0;
    padding: 4px 0 4px 14px;
    border-left: 3px solid var(--dd-border-strong);
}
.dd-md-transclusion-head { font-size: 0.85em; margin-bottom: 6px; }
.dd-md-transclusion-body > :first-child { margin-top: 0; }
.dd-md-transclusion-body > :last-child { margin-bottom: 0; }
.dd-md-transclusion-missing { color: var(--dd-text-faint); font-style: italic; }

.dd-md-properties {
    margin: 0 0 1.4em;
    padding: 8px 14px;
    border: 1px solid var(--dd-border);
    border-radius: 8px;
    background: var(--dd-bg-panel);
    font-size: 0.9em;
}
.dd-md-properties > summary { cursor: pointer; color: var(--dd-text-dim); font-weight: 600; }
.dd-md-properties dl {
    display: grid;
    grid-template-columns: minmax(90px, max-content) 1fr;
    gap: 6px 16px;
    margin: 10px 0 4px;
}
.dd-md-properties dt { color: var(--dd-text-dim); font-family: var(--dd-mono); font-size: 0.92em; }
.dd-md-properties dd { margin: 0; white-space: pre-wrap; word-break: break-word; }
.dd-md-prop-chip {
    display: inline-block;
    margin: 0 6px 4px 0;
    padding: 0 8px;
    border-radius: 10px;
    background: var(--dd-accent-soft);
    color: var(--dd-accent);
    font-size: 0.92em;
}

sup.footnote-ref a { padding: 0 1px; text-decoration: none; }
section.footnotes { margin-top: 2.4em; font-size: 0.92em; color: var(--dd-text-dim); }
section.footnotes hr { margin-bottom: 1.2em; }
section.footnotes li:target { background: var(--dd-accent-soft); border-radius: 4px; }
.footnote-backref { text-decoration: none; }
.dd-block-id { display: inline; }
:target { scroll-margin-top: 72px; }
/* A heading a link jumped to, in the page or in the panel, is marked for a moment; page settings set how long. */
@keyframes dd-heading-flash { from { background: var(--dd-accent-soft); } to { background: transparent; } }
h1:target, h2:target, h3:target, h4:target, h5:target, h6:target, .dd-heading-hit {
    animation: dd-heading-flash var(--dd-heading-flash, ${HEADING_FLASH_DEFAULT_MS}ms) ease-out;
    border-radius: 4px;
}
html.dd-heading-flash-off :is(h1, h2, h3, h4, h5, h6):target, html.dd-heading-flash-off .dd-heading-hit {
    animation: none;
}
/* A picture alone opens the viewer from the keyboard too (Enter or Space), so its tab stop shows. */
img[data-dd-viewer]:focus-visible { outline: 2px solid var(--dd-accent); outline-offset: 2px; }
/* The image viewer: a click on an image or a link to one opens it over the page. */
article img, .dd-share-panel-body img, a[data-asset-image] { cursor: zoom-in; }
body.dd-lightbox-open { overflow: hidden; }
.dd-lightbox {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    background: rgba(5, 7, 9, 0.9);
}
.dd-lightbox[hidden] { display: none; }
.dd-lightbox-stage {
    position: relative;
    flex: 1;
    overflow: hidden;
    touch-action: none;
}
.dd-lightbox-stage.dd-lightbox-pannable { cursor: grab; }
.dd-lightbox-stage.dd-lightbox-panning { cursor: grabbing; }
.dd-lightbox-img {
    position: absolute;
    left: 0;
    top: 0;
    max-width: none;
    max-height: none;
    transform-origin: 0 0;
    user-select: none;
    -webkit-user-drag: none;
}
.dd-lightbox-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--dd-bg-panel);
    border-top: 1px solid var(--dd-border-strong);
    color: var(--dd-text);
    font-family: var(--dd-sans);
    font-size: 13px;
}
.dd-lightbox-caption {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dd-text-dim);
}
.dd-lightbox-count, .dd-lightbox-zoom {
    font-family: var(--dd-mono);
    font-size: 12px;
    color: var(--dd-text-dim);
    font-variant-numeric: tabular-nums;
}
.dd-lightbox-zoom { min-width: 4.5em; text-align: center; }
.dd-lightbox-bar a, .dd-lightbox-bar button {
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
.dd-lightbox-bar a:hover, .dd-lightbox-bar button:hover { color: var(--dd-accent); border-color: var(--dd-accent); }
.dd-lightbox-bar button[hidden] { display: none; }

@media (prefers-reduced-motion: reduce) {
    h1:target, h2:target, h3:target, h4:target, h5:target, h6:target, .dd-heading-hit {
        animation: none;
    }
    html:not(.dd-heading-flash-off) :is(h1, h2, h3, h4, h5, h6):target,
    html:not(.dd-heading-flash-off) .dd-heading-hit {
        background: var(--dd-accent-soft);
    }
}

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

.dd-details {
    --fold: var(--dd-accent-2, #2dd4bf);
    margin: 1.2em 0;
    border: 1px solid color-mix(in srgb, var(--fold) 30%, var(--dd-border));
    border-left: 4px solid var(--fold);
    border-radius: 0 10px 10px 0;
    background: color-mix(in srgb, var(--fold) 6%, var(--dd-bg-panel));
    overflow: hidden;
}

.dd-details-summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
    user-select: none;
}

.dd-details-summary::-webkit-details-marker { display: none; }

.dd-details-summary::before {
    content: "";
    flex: none;
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--fold);
    border-bottom: 2px solid var(--fold);
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
    margin: 0 4px 0 2px;
}

.dd-details[open] > .dd-details-summary::before { transform: rotate(45deg); }

.dd-details-title { flex: 1; min-width: 0; }
.dd-details-title code { color: inherit; }

.dd-details-summary::after {
    content: "Show";
    flex: none;
    font-size: 0.72em;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fold);
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--fold) 45%, transparent);
    background: color-mix(in srgb, var(--fold) 12%, transparent);
}

.dd-details[open] > .dd-details-summary::after { content: "Hide"; }
.dd-details-summary:hover { background: color-mix(in srgb, var(--fold) 10%, transparent); }

.dd-details-body {
    padding: 4px 16px 12px;
    border-top: 1px solid color-mix(in srgb, var(--fold) 22%, var(--dd-border));
}

.dd-details-body > :first-child { margin-top: 12px; }
.dd-details-body > :last-child { margin-bottom: 0; }

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

.dd-share-download,
.dd-share-settings {
    position: relative;
}

.dd-share-settings-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 240px;
    padding: 10px;
    border: 1px solid var(--dd-border-strong);
    border-radius: 8px;
    background: var(--dd-bg-elevated);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    color: var(--dd-text);
    font-size: 13px;
}

.dd-share-settings-menu[hidden] {
    display: none;
}

.dd-share-settings-menu label {
    display: block;
    margin-bottom: 6px;
}

.dd-share-settings-menu small {
    display: block;
    margin-top: 2px;
    color: var(--dd-text-faint);
    font-size: 11px;
}

.dd-share-settings-menu select {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--dd-border-strong);
    border-radius: 6px;
    background: var(--dd-bg-panel);
    color: var(--dd-text);
    font: inherit;
}

.dd-share-download-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 220px;
    padding: 4px;
    border: 1px solid var(--dd-border-strong);
    border-radius: 8px;
    background: var(--dd-bg-elevated);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.dd-share-download-menu[hidden] {
    display: none;
}

.dd-share-download-menu a,
.dd-share-download-menu button {
    display: block;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--dd-text);
    font: inherit;
    font-size: 13px;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
}

.dd-share-download-menu a:hover,
.dd-share-download-menu a:focus-visible,
.dd-share-download-menu button:hover,
.dd-share-download-menu button:focus-visible {
    background: var(--dd-accent-soft);
    color: var(--dd-accent);
    outline: none;
}

.dd-share-download-menu small {
    display: block;
    margin-top: 2px;
    color: var(--dd-text-faint);
    font-size: 11px;
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

function buildMermaidScript(code: string): string {
    // Note-authored diagram styles must never enter the public page's DOM or CSS cascade.
    const prefix = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:0;background:#101316} .mermaid{margin:0}</style><script>${code.replace(/<\/script/gi, "<\\/script")}</script><div class="mermaid">`;
    const suffix = `</div><script>
mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
mermaid.run().then(function () {
    var diagram = document.querySelector('.mermaid');
    function resize() {
        var svg = diagram.querySelector('svg');
        if (svg) parent.postMessage({ ddMermaidHeight: Math.ceil(svg.getBoundingClientRect().height) + 16 }, '*');
    }
    new ResizeObserver(resize).observe(diagram);
    resize();
}).catch(function (error) { console.error('Mermaid rendering failed', error); });
</script>`;
    return `<script>
(function () {
    var prefix = ${embedJson(prefix)};
    var suffix = ${embedJson(suffix)};
    var frames = [];
    document.querySelectorAll('.mermaid').forEach(function (diagram) {
        var frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('title', 'Mermaid diagram');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.style.cssText = 'display:block;width:100%;height:300px;border:0';
        var text = diagram.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        frame.srcdoc = prefix + text + suffix;
        frames.push(frame);
        diagram.replaceWith(frame);
    });
    window.addEventListener('message', function (event) {
        var frame = frames.find(function (item) { return item.contentWindow === event.source; });
        var height = event.data && event.data.ddMermaidHeight;
        if (frame && typeof height === 'number' && Number.isFinite(height)) {
            frame.style.height = Math.max(80, Math.min(4000, height)) + 'px';
        }
    });
})();
</script>`;
}

const FILE_CODE_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/></svg>';

const BOOK_OPEN_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';

const DOWNLOAD_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';

const SETTINGS_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>';

/** How long a heading a link jumps to stays marked: the page settings' choices, kept per browser. 0 turns it off. */
export const HEADING_FLASH_OPTIONS: ReadonlyArray<{ ms: number; label: string }> = [
    { ms: 0, label: "Off" },
    { ms: 900, label: "Short" },
    { ms: 1800, label: "Normal" },
    { ms: 3600, label: "Long" },
];
export const HEADING_FLASH_DEFAULT_MS = 1800;
export const HEADING_FLASH_STORAGE_KEY = "dd-share:heading-flash-ms";

function embedJson(value: unknown): string {
    return SafeJSON.stringify(value).replace(/</g, "\\u003c");
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

    function downloadSource() {
        var blob = new Blob([panel.textContent], { type: ${SafeJSON.stringify(contentType)} });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = ${SafeJSON.stringify(downloadName)};
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    var downloadBtn = document.getElementById("dd-share-download-btn");
    var downloadMenu = document.getElementById("dd-share-download-menu");
    if (downloadBtn && downloadMenu) {
        var setMenu = function (open) {
            downloadMenu.hidden = !open;
            downloadBtn.setAttribute("aria-expanded", open ? "true" : "false");
            if (open) {
                downloadMenu.querySelector("a, button").focus();
            }
        };
        downloadBtn.addEventListener("click", function () {
            setMenu(downloadMenu.hidden);
        });
        document.getElementById("dd-share-download-md").addEventListener("click", function () {
            setMenu(false);
            downloadBtn.focus();
            downloadSource();
        });
        var menuLinks = downloadMenu.querySelectorAll("a");
        for (var m = 0; m < menuLinks.length; m++) {
            menuLinks[m].addEventListener("click", function () {
                setMenu(false);
                downloadBtn.focus();
            });
        }
        document.addEventListener("click", function (event) {
            if (!downloadMenu.hidden && !downloadMenu.parentElement.contains(event.target)) {
                setMenu(false);
            }
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !downloadMenu.hidden) {
                setMenu(false);
                downloadBtn.focus();
            }
        });
    } else if (downloadBtn) {
        downloadBtn.addEventListener("click", downloadSource);
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

/**
 * The image viewer: a click on an image of the page or of the side panel, or on a link to an image, opens it over
 * the page instead of leaving it. Wheel and pinch zoom around the pointer, a drag moves a zoomed image, a double
 * click goes between fit and 100 %, the arrow keys go through the images of the same page or panel. A click with
 * Cmd, Ctrl, Shift or Alt, or with the middle button, keeps the browser's own behaviour.
 */
function buildLightboxScript(): string {
    return `<script>
(function () {
    var box = document.getElementById("dd-lightbox");
    var stage = document.getElementById("dd-lightbox-stage");
    var view = document.getElementById("dd-lightbox-img");
    var caption = document.getElementById("dd-lightbox-caption");
    var counter = document.getElementById("dd-lightbox-count");
    var zoomLabel = document.getElementById("dd-lightbox-zoom");
    var original = document.getElementById("dd-lightbox-original");
    var prevBtn = document.getElementById("dd-lightbox-prev");
    var nextBtn = document.getElementById("dd-lightbox-next");
    var closeBtn = document.getElementById("dd-lightbox-close");
    if (!box || !stage || !view) {
        return;
    }

    var IMAGE_FILE = new RegExp("[.](png|jpe?g|gif|webp|avif|svg|bmp|tiff?)([?#]|$)", "i");
    var MAX_SCALE = 8;
    var list = [];
    var index = 0;
    var scale = 1;
    var fit = 1;
    var x = 0;
    var y = 0;
    var natural = { w: 0, h: 0 };
    var lastFocus = null;
    var saved = [];
    var pointers = {};
    var drag = null;
    var pinch = null;
    var gestureScale = 1;

    function scopeOf(el) {
        return el.closest("#dd-share-panel-body") || el.closest("article");
    }

    function isImageLink(link) {
        var raw = link.getAttribute("href") || "";
        if (!raw || raw.charAt(0) === "#") {
            return false;
        }
        return link.hasAttribute("data-asset-image") || link.href.indexOf("data:image/") === 0 || IMAGE_FILE.test(link.href);
    }

    // What a clicked element shows: a link to an image shows that image, an image alone shows itself, and an image
    // inside a link to a page is no image to show (the click follows the link).
    function itemOf(el) {
        if (el.tagName === "A") {
            if (!isImageLink(el)) {
                return null;
            }
            var inner = el.querySelector("img");
            var label = inner ? inner.getAttribute("alt") || "" : (el.textContent || "").trim();
            return { el: el, show: el.href, open: el.href, caption: label };
        }
        var link = el.closest("a[href]");
        if (link) {
            return isImageLink(link) ? itemOf(link) : null;
        }
        var src = el.currentSrc || el.src;
        return src ? { el: el, show: src, open: src, caption: el.getAttribute("alt") || "" } : null;
    }

    function itemsIn(scope) {
        var items = [];
        var nodes = scope.querySelectorAll("a[href], img");
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            // An image inside an image link is that link's item already.
            if (node.tagName === "IMG" && node.closest("a[href]")) {
                continue;
            }
            var item = itemOf(node);
            if (item) {
                items.push(item);
            }
        }
        return items;
    }

    function setBehind(on) {
        if (!on) {
            for (var j = 0; j < saved.length; j++) {
                if (!saved[j][1]) {
                    saved[j][0].removeAttribute("inert");
                }
            }
            saved = [];
            return;
        }
        var els = [
            document.querySelector(".dd-share-toolbar"),
            document.querySelector("main"),
            document.getElementById("dd-share-panel"),
            document.getElementById("dd-share-panel-backdrop"),
        ];
        saved = [];
        for (var i = 0; i < els.length; i++) {
            if (els[i]) {
                saved.push([els[i], els[i].hasAttribute("inert")]);
                els[i].setAttribute("inert", "");
            }
        }
    }

    function stageSize() {
        return { w: stage.clientWidth, h: stage.clientHeight };
    }

    function apply() {
        var s = stageSize();
        var w = natural.w * scale;
        var h = natural.h * scale;
        x = w <= s.w ? (s.w - w) / 2 : Math.min(0, Math.max(s.w - w, x));
        y = h <= s.h ? (s.h - h) / 2 : Math.min(0, Math.max(s.h - h, y));
        view.style.width = natural.w + "px";
        view.style.height = natural.h + "px";
        view.style.transform = "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
        stage.classList.toggle("dd-lightbox-pannable", w > s.w + 0.5 || h > s.h + 0.5);
        zoomLabel.textContent = Math.round(scale * 100) + " %";
    }

    function toFit() {
        var s = stageSize();
        fit = Math.min(1, s.w / natural.w, s.h / natural.h);
        scale = fit;
        apply();
    }

    // Keeps the point under (px, py) where it is: wheel and pinch zoom around the pointer.
    function zoomTo(next, px, py) {
        if (!natural.w) {
            return;
        }
        var s = stageSize();
        var cx = px === undefined ? s.w / 2 : px;
        var cy = py === undefined ? s.h / 2 : py;
        var target = Math.max(fit, Math.min(MAX_SCALE, next));
        x = cx - (cx - x) * (target / scale);
        y = cy - (cy - y) * (target / scale);
        scale = target;
        apply();
    }

    function show(i) {
        index = (i + list.length) % list.length;
        var item = list[index];
        caption.textContent = item.caption;
        counter.textContent = list.length > 1 ? index + 1 + " / " + list.length : "";
        prevBtn.hidden = list.length < 2;
        nextBtn.hidden = list.length < 2;
        original.href = item.open;
        if (item.open.indexOf("data:") === 0) {
            original.setAttribute("download", item.caption || "image");
        } else {
            original.removeAttribute("download");
        }
        natural = { w: 0, h: 0 };
        view.style.visibility = "hidden";
        view.alt = item.caption;
        view.onload = function () {
            var thumb = item.el.tagName === "IMG" ? item.el : item.el.querySelector("img");
            natural = {
                w: view.naturalWidth || (thumb && thumb.naturalWidth) || 800,
                h: view.naturalHeight || (thumb && thumb.naturalHeight) || 600,
            };
            toFit();
            view.style.visibility = "";
        };
        view.onerror = function () {
            caption.textContent = "Could not load " + (item.caption || "the image") + ".";
        };
        if (view.src === item.show && view.complete && view.naturalWidth) {
            view.onload();
        } else {
            view.src = item.show;
        }
    }

    function open(el) {
        var scope = scopeOf(el);
        list = scope ? itemsIn(scope) : [];
        index = -1;
        for (var i = 0; i < list.length; i++) {
            if (list[i].el === el) {
                index = i;
            }
        }
        if (index === -1) {
            var item = itemOf(el);
            if (!item) {
                return;
            }
            list = [item];
            index = 0;
        }
        lastFocus = document.activeElement;
        box.hidden = false;
        document.body.classList.add("dd-lightbox-open");
        setBehind(true);
        show(index);
        closeBtn.focus();
    }

    function close() {
        if (box.hidden) {
            return;
        }
        box.hidden = true;
        document.body.classList.remove("dd-lightbox-open");
        setBehind(false);
        view.onload = null;
        view.onerror = null;
        view.removeAttribute("src");
        pointers = {};
        drag = null;
        pinch = null;
        if (lastFocus && lastFocus.focus) {
            lastFocus.focus();
        }
    }

    // A picture alone is no link, so the keyboard reaches it as a button: a tab stop, a name, and Enter or Space
    // open it as a click does. A picture inside a link keeps the link. The panel's pictures arrive later.
    function markImages(root) {
        var imgs = root.querySelectorAll("img:not([data-dd-viewer])");
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            if (img.closest("a[href]") || !scopeOf(img)) {
                continue;
            }
            var alt = img.getAttribute("alt") || "";
            img.setAttribute("data-dd-viewer", "");
            img.setAttribute("tabindex", "0");
            img.setAttribute("role", "button");
            img.setAttribute("aria-label", alt ? "Open image: " + alt : "Open image");
        }
    }
    var article = document.querySelector("article");
    if (article) {
        markImages(article);
    }
    var panelBody = document.getElementById("dd-share-panel-body");
    if (panelBody && window.MutationObserver) {
        new MutationObserver(function () {
            markImages(panelBody);
        }).observe(panelBody, { childList: true, subtree: true });
    }
    document.addEventListener("keydown", function (event) {
        var target = event.target;
        if (!box.hidden || event.metaKey || event.ctrlKey || event.altKey || (event.key !== "Enter" && event.key !== " ")) {
            return;
        }
        if (!target || target.tagName !== "IMG" || !target.hasAttribute("data-dd-viewer")) {
            return;
        }
        event.preventDefault();
        open(target);
    });

    document.addEventListener("click", function (event) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
        }
        var target = event.target;
        if (!target || !target.closest || target.closest("#dd-lightbox")) {
            return;
        }
        var el = target.closest("a[href]") || target.closest("img");
        if (!el || !scopeOf(el) || !itemOf(el)) {
            return;
        }
        event.preventDefault();
        open(el);
    });

    stage.addEventListener("wheel", function (event) {
        if (box.hidden || !natural.w) {
            return;
        }
        event.preventDefault();
        var r = stage.getBoundingClientRect();
        var delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        // A trackpad pinch arrives as a wheel with ctrlKey and small steps; a mouse wheel moves in big ones.
        zoomTo(scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), event.clientX - r.left, event.clientY - r.top);
    }, { passive: false });

    // Safari sends a trackpad pinch as gesture events.
    stage.addEventListener("gesturestart", function (event) {
        event.preventDefault();
        gestureScale = scale;
    });
    stage.addEventListener("gesturechange", function (event) {
        event.preventDefault();
        var r = stage.getBoundingClientRect();
        zoomTo(gestureScale * event.scale, event.clientX - r.left, event.clientY - r.top);
    });

    stage.addEventListener("pointerdown", function (event) {
        if (event.pointerType === "mouse" && event.button !== 0) {
            return;
        }
        pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
        stage.setPointerCapture(event.pointerId);
        var ids = Object.keys(pointers);
        if (ids.length === 2) {
            var a = pointers[ids[0]];
            var b = pointers[ids[1]];
            pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: scale };
            drag = null;
        } else if (ids.length === 1) {
            drag = { startX: event.clientX, startY: event.clientY, x0: x, y0: y, moved: false, onImage: event.target === view };
        }
    });

    stage.addEventListener("pointermove", function (event) {
        if (!pointers[event.pointerId]) {
            return;
        }
        pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
        var ids = Object.keys(pointers);
        if (pinch && ids.length === 2) {
            var a = pointers[ids[0]];
            var b = pointers[ids[1]];
            var r = stage.getBoundingClientRect();
            zoomTo(pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
            return;
        }
        if (!drag) {
            return;
        }
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) {
            return;
        }
        drag.moved = true;
        stage.classList.add("dd-lightbox-panning");
        x = drag.x0 + dx;
        y = drag.y0 + dy;
        apply();
    });

    function endPointer(event) {
        if (!pointers[event.pointerId]) {
            return;
        }
        delete pointers[event.pointerId];
        var left = Object.keys(pointers).length;
        if (left < 2) {
            pinch = null;
        }
        if (left === 0) {
            var ended = drag;
            drag = null;
            stage.classList.remove("dd-lightbox-panning");
            // A click on the dimmed background closes the viewer; the end of a drag does not.
            if (ended && !ended.moved && !ended.onImage && event.type === "pointerup") {
                close();
            }
        }
    }
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);

    stage.addEventListener("dblclick", function (event) {
        if (event.target !== view) {
            return;
        }
        var r = stage.getBoundingClientRect();
        var atFit = Math.abs(scale - fit) < 0.001;
        zoomTo(atFit ? (fit < 1 ? 1 : 2) : fit, event.clientX - r.left, event.clientY - r.top);
    });

    // In the capture phase: an Escape closes the viewer only, not the side panel under it.
    document.addEventListener("keydown", function (event) {
        if (box.hidden || event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        var key = event.key;
        if (key === "Escape") {
            close();
        } else if (key === "ArrowLeft" && list.length > 1) {
            show(index - 1);
        } else if (key === "ArrowRight" && list.length > 1) {
            show(index + 1);
        } else if (key === "+" || key === "=") {
            zoomTo(scale * 1.25);
        } else if (key === "-" || key === "_") {
            zoomTo(scale / 1.25);
        } else if (key === "0") {
            toFit();
        } else if (key === "1") {
            zoomTo(1);
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    }, true);

    window.addEventListener("resize", function () {
        if (box.hidden || !natural.w) {
            return;
        }
        var atFit = Math.abs(scale - fit) < 0.001;
        var s = stageSize();
        fit = Math.min(1, s.w / natural.w, s.h / natural.h);
        scale = atFit ? fit : Math.max(fit, scale);
        apply();
    });

    prevBtn.addEventListener("click", function () { show(index - 1); });
    nextBtn.addEventListener("click", function () { show(index + 1); });
    document.getElementById("dd-lightbox-in").addEventListener("click", function () { zoomTo(scale * 1.25); });
    document.getElementById("dd-lightbox-out").addEventListener("click", function () { zoomTo(scale / 1.25); });
    document.getElementById("dd-lightbox-fit").addEventListener("click", function () { toFit(); });
    document.getElementById("dd-lightbox-actual").addEventListener("click", function () { zoomTo(1); });
    closeBtn.addEventListener("click", close);
})();
</script>`;
}

/**
 * The page settings menu: how long a heading a link jumps to stays marked (`HEADING_FLASH_OPTIONS`), kept in this
 * browser's storage like the reading width.
 */
function buildSettingsScript(): string {
    return `<script>
(function () {
    var KEY = ${SafeJSON.stringify(HEADING_FLASH_STORAGE_KEY)};
    var DEFAULT_MS = ${HEADING_FLASH_DEFAULT_MS};
    var CHOICES = ${SafeJSON.stringify(HEADING_FLASH_OPTIONS.map((option) => option.ms))};
    var root = document.documentElement;
    var btn = document.getElementById("dd-share-settings-btn");
    var menu = document.getElementById("dd-share-settings-menu");
    var select = document.getElementById("dd-share-heading-flash");

    function apply(ms) {
        root.classList.toggle("dd-heading-flash-off", ms === 0);
        if (ms > 0) {
            root.style.setProperty("--dd-heading-flash", ms + "ms");
        } else {
            root.style.removeProperty("--dd-heading-flash");
        }
    }

    var ms = DEFAULT_MS;
    try {
        var stored = Number(localStorage.getItem(KEY));
        if (localStorage.getItem(KEY) !== null && CHOICES.indexOf(stored) !== -1) {
            ms = stored;
        }
    } catch (e) {
        // No storage: the default.
    }
    apply(ms);

    if (!btn || !menu || !select) {
        return;
    }
    select.value = String(ms);
    select.addEventListener("change", function () {
        var next = Number(select.value);
        apply(next);
        try {
            if (next === DEFAULT_MS) {
                localStorage.removeItem(KEY);
            } else {
                localStorage.setItem(KEY, String(next));
            }
        } catch (e) {
            // Storage can be off (private mode); the choice then lasts for this page only.
        }
    });

    function setMenu(open) {
        menu.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
            select.focus();
        }
    }
    btn.addEventListener("click", function () {
        setMenu(menu.hidden);
    });
    document.addEventListener("click", function (event) {
        if (!menu.hidden && !menu.parentElement.contains(event.target)) {
            setMenu(false);
        }
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !menu.hidden) {
            setMenu(false);
            btn.focus();
        }
    });
})();
</script>`;
}

function buildWidthScript(): string {
    return `<script>
(function () {
    var KEY = "dd-share:reading-width";
    var MIN = 420;
    var main = document.querySelector("main");
    if (!main) {
        return;
    }

    var root = document.documentElement.style;
    function apply(px) {
        if (px && px >= MIN) {
            root.setProperty("--dd-share-width", Math.round(px) + "px");
        } else {
            root.removeProperty("--dd-share-width");
        }
    }
    function save(px) {
        try {
            if (px) {
                localStorage.setItem(KEY, String(Math.round(px)));
            } else {
                localStorage.removeItem(KEY);
            }
        } catch (e) {
            // Storage can be off (private mode); the width then lasts for this page only.
        }
    }
    function clamp(px) {
        var maxW = Math.max(MIN, document.body.clientWidth - 60);
        return Math.round(Math.max(MIN, Math.min(maxW, px)));
    }
    try {
        apply(Number(localStorage.getItem(KEY)) || 0);
    } catch (e) {
        // No storage: the default width.
    }

    ["l", "r"].forEach(function (side) {
        var sign = side === "r" ? 1 : -1;
        var grip = document.createElement("div");
        grip.className = "dd-share-grip dd-share-grip-" + side;
        grip.setAttribute("role", "separator");
        grip.setAttribute("aria-orientation", "vertical");
        grip.setAttribute("aria-label", "Reading width");
        grip.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Enter");
        grip.title = "Drag to resize, double-click to reset";
        grip.tabIndex = 0;
        main.appendChild(grip);

        grip.addEventListener("pointerdown", function (e) {
            if (e.button !== 0) {
                return;
            }
            e.preventDefault();
            grip.setPointerCapture(e.pointerId);
            var startX = e.clientX;
            var startW = main.getBoundingClientRect().width;
            var previous = root.getPropertyValue("--dd-share-width");
            var w = startW;
            grip.classList.add("dd-share-grip-active");
            document.body.classList.add("dd-share-resizing");
            function move(ev) {
                // The column is centred, so one edge moving by dx widens it by 2 * dx.
                w = clamp(startW + sign * (ev.clientX - startX) * 2);
                apply(w);
            }
            function up(ev) {
                grip.removeEventListener("pointermove", move);
                grip.removeEventListener("pointerup", up);
                grip.removeEventListener("pointercancel", up);
                grip.classList.remove("dd-share-grip-active");
                document.body.classList.remove("dd-share-resizing");
                if (ev.type === "pointercancel") {
                    if (previous) {
                        root.setProperty("--dd-share-width", previous);
                    } else {
                        root.removeProperty("--dd-share-width");
                    }
                } else {
                    save(w);
                }
            }
            grip.addEventListener("pointermove", move);
            grip.addEventListener("pointerup", up);
            grip.addEventListener("pointercancel", up);
        });
        grip.addEventListener("dblclick", function (e) {
            e.preventDefault();
            apply(0);
            save(0);
        });
        grip.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
                e.preventDefault();
                apply(0);
                save(0);
                return;
            }
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
                return;
            }
            e.preventDefault();
            var dx = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 60 : 20);
            var w = clamp(main.getBoundingClientRect().width + sign * dx * 2);
            apply(w);
            save(w);
        });
    });

    function updateValues() {
        var current = Math.round(main.getBoundingClientRect().width);
        var maximum = Math.max(current, document.body.clientWidth - 60);
        var minimum = Math.min(MIN, maximum);
        main.querySelectorAll(".dd-share-grip").forEach(function (grip) {
            grip.setAttribute("aria-valuemin", String(minimum));
            grip.setAttribute("aria-valuemax", String(maximum));
            grip.setAttribute("aria-valuenow", String(current));
            grip.setAttribute("aria-valuetext", current + " pixels");
        });
    }
    updateValues();
    var observer = new ResizeObserver(updateValues);
    observer.observe(main);
    observer.observe(document.body);
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
    var embeddedEl = document.getElementById("dd-share-embedded-panels");
    // A saved copy has no server: panels come from the page itself and the URL never changes.
    var embedded = embeddedEl ? JSON.parse(embeddedEl.textContent) : null;
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

    // A link to a heading of another note opens the panel at that heading, and marks it for a moment.
    function markHeading(hash) {
        if (!hash || hash.length < 2 || parseLines(hash)) {
            return;
        }

        var id = hash.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch (err) {
            // A literal % stays as it is.
        }
        var selector = '[id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]';
        var heading = content.querySelector(selector);
        if (!heading) {
            return;
        }

        heading.scrollIntoView({ block: "start" });
        heading.classList.remove("dd-heading-hit");
        void heading.offsetWidth;
        heading.classList.add("dd-heading-hit");
    }

    function openPanel(url, push) {
        var hashAt = url.indexOf("#");
        var base = hashAt === -1 ? url : url.slice(0, hashAt);
        var hash = hashAt === -1 ? "" : url.slice(hashAt);
        var lines = parseLines(hash);
        var name = nameFor(base);
        lastFocus = document.activeElement;
        title.textContent = lines ? name + ":" + lines.start + (lines.end > lines.start ? "-" + lines.end : "") : name;
        content.textContent = "Loading " + name + "\u2026";
        document.body.classList.add("dd-share-panel-open");
        panel.setAttribute("aria-hidden", "false");
        panel.removeAttribute("inert");
        setBehindInert(true);
        isOpen = true;
        var request = ++panelRequest;
        if (embedded) {
            var entry = embedded.panels[base + "|" + (lines ? lines.start + "-" + lines.end : "")] || embedded.panels[base + "|"];
            if (entry) {
                rawLink.href = embedded.raws[entry.raw];
                rawLink.setAttribute("download", name);
                content.innerHTML = entry.html;
                content.scrollTop = 0;
                markLines(lines);
                markHeading(hash);
            } else {
                rawLink.removeAttribute("href");
                content.textContent = name + " is not part of this saved page.";
            }
            closeBtn.focus();
            return;
        }

        rawLink.href = base + "&view=raw";
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
                markHeading(hash);
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
        if (push && !embedded) {
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
    const {
        title,
        rendered,
        source,
        sourcePath,
        openAssetUrl,
        attachmentCount = 0,
        downloads,
        embeddedPanels,
        offlineAssets,
        mermaidCode,
    } = options;
    const headExtras: string[] = offlineAssets
        ? [`<style>${offlineAssets.css}</style>`]
        : [
              `<link rel="preconnect" href="https://fonts.googleapis.com">`,
              `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
              `<link rel="stylesheet" href="${INTER_FONT_URL}">`,
              `<link rel="stylesheet" href="${HLJS_CSS_URL}" integrity="${HLJS_CSS_SRI}" crossorigin="anonymous">`,
          ];

    if (rendered.hasMath && !offlineAssets) {
        headExtras.push(
            `<link rel="stylesheet" href="${KATEX_CSS_URL}" integrity="${KATEX_CSS_SRI}" crossorigin="anonymous">`
        );
    }

    const bodyExtras: string[] = [];

    if (rendered.hasMermaid && mermaidCode) {
        bodyExtras.push(buildMermaidScript(mermaidCode));
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
    bodyExtras.push(buildLightboxScript());
    bodyExtras.push(buildWidthScript());
    bodyExtras.push(buildSettingsScript());

    const attachmentsLabel = `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`;
    const zipItem =
        downloads && attachmentCount > 0
            ? `<a href="${escapeHtml(downloads.zip)}" download>With all attachments<small>zip, ${attachmentsLabel}</small></a>`
            : "";
    const downloadControl = downloads
        ? `<div class="dd-share-download">
<button type="button" class="dd-share-view-btn" id="dd-share-download-btn" aria-label="Download" title="Download" aria-expanded="false" aria-controls="dd-share-download-menu">${DOWNLOAD_ICON}</button>
<div class="dd-share-download-menu" id="dd-share-download-menu" hidden>
<button type="button" id="dd-share-download-md">${isSourceFile ? "Source file only" : "Markdown only"}<small>${escapeHtml(downloadName)}</small></button>
${zipItem}
<a href="${escapeHtml(downloads.html)}" download>Save as HTML<small>one file${attachmentCount > 0 ? `, ${attachmentsLabel} embedded` : ""}</small></a>
</div>
</div>`
        : `<button type="button" class="dd-share-view-btn" id="dd-share-download-btn" aria-label="${escapeHtml(labels.download)}" title="${escapeHtml(labels.download)}">${DOWNLOAD_ICON}</button>`;

    const flashOptions = HEADING_FLASH_OPTIONS.map(
        (option) =>
            `<option value="${option.ms}"${option.ms === HEADING_FLASH_DEFAULT_MS ? " selected" : ""}>${escapeHtml(option.label)}</option>`
    ).join("");
    const settingsControl = `<div class="dd-share-settings">
<button type="button" class="dd-share-view-btn" id="dd-share-settings-btn" aria-label="Page settings" title="Page settings" aria-expanded="false" aria-controls="dd-share-settings-menu">${SETTINGS_ICON}</button>
<div class="dd-share-settings-menu" id="dd-share-settings-menu" hidden>
<label for="dd-share-heading-flash">Heading highlight<small>How long a heading a link jumps to stays marked</small></label>
<select id="dd-share-heading-flash">${flashOptions}</select>
</div>
</div>`;

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
${downloadControl}
${settingsControl}
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
<div class="dd-lightbox" id="dd-lightbox" role="dialog" aria-modal="true" aria-label="Image" hidden>
<div class="dd-lightbox-stage" id="dd-lightbox-stage"><img class="dd-lightbox-img" id="dd-lightbox-img" alt="" draggable="false"></div>
<div class="dd-lightbox-bar">
<button type="button" id="dd-lightbox-prev" aria-label="Previous image" title="Previous image (Left arrow)">&lsaquo;</button>
<span class="dd-lightbox-count" id="dd-lightbox-count"></span>
<button type="button" id="dd-lightbox-next" aria-label="Next image" title="Next image (Right arrow)">&rsaquo;</button>
<span class="dd-lightbox-caption" id="dd-lightbox-caption"></span>
<button type="button" id="dd-lightbox-out" aria-label="Zoom out" title="Zoom out (-)">&minus;</button>
<span class="dd-lightbox-zoom" id="dd-lightbox-zoom">100 %</span>
<button type="button" id="dd-lightbox-in" aria-label="Zoom in" title="Zoom in (+)">+</button>
<button type="button" id="dd-lightbox-fit" title="Fit to the window (0)">Fit</button>
<button type="button" id="dd-lightbox-actual" title="Actual size (1)">100 %</button>
<a id="dd-lightbox-original" href="#" target="_blank" rel="noopener">Open original</a>
<button type="button" id="dd-lightbox-close" aria-label="Close image" title="Close (Esc)">Close</button>
</div>
</div>
<script type="application/json" id="dd-share-source-data">${embedJson(source)}</script>
${embeddedPanels ? `<script type="application/json" id="dd-share-embedded-panels">${embedJson(embeddedPanels)}</script>` : ""}
${bodyExtras.join("\n")}
</body>
</html>`;
}

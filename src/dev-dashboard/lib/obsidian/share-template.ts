import type { RenderResult } from "@app/dev-dashboard/lib/obsidian/markdown";
import { escapeHtml } from "@app/utils/string";

interface ShareTemplateOptions {
    title: string;
    rendered: RenderResult;
    sourcePath?: string;
}

const HLJS_CSS_URL = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/atom-one-dark.min.css";
const HLJS_CSS_SRI = "sha384-oaMLBGEzBOJx3UHwac0cVndtX5fxGQIfnAeFZ35RTgqPcYlbprH9o9PUV/F8Le07";
const KATEX_CSS_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
const KATEX_CSS_SRI = "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+";
const MERMAID_JS_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";
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

export function renderSharePage(options: ShareTemplateOptions): string {
    const { title, rendered, sourcePath } = options;
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

    const bodyExtras: string[] = [];

    if (rendered.hasMermaid) {
        bodyExtras.push(buildMermaidScript());
    }

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
<body>
<main>
<article>${rendered.html}</article>
<footer class="dd-share-footer">shared via dev-dashboard${sourceLine}</footer>
</main>
${bodyExtras.join("\n")}
</body>
</html>`;
}

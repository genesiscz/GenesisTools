#!/usr/bin/env node
import { Readability } from "@mozilla/readability";
import axios from "axios";
import chalk from "chalk";
import { Command } from "commander";
import { createTwoFilesPatch } from "diff";
import { decode, encode } from "gpt-3-encoder";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Basic CLI logger similar to watch tool
const log = {
    info: (msg: string) => console.log(chalk.blue("ℹ️ ") + msg),
    ok: (msg: string) => console.log(chalk.green("✔ ") + msg),
    warn: (msg: string) => console.log(chalk.yellow("⚠ ") + msg),
    err: (msg: string, e?: unknown) => console.error(chalk.red("❌ ") + msg + (e ? `: ${String(e)}` : "")),
};

// Helpers
const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function ensureHttpUrl(u: string): string {
    if (!/^https?:\/\//i.test(u)) return "https://" + u;
    return u;
}

function buildJinaUrl(u: string): string {
    // Jina Reader pattern: https://r.jina.ai/http://{host+path}
    const stripped = u.replace(/^https?:\/\//i, "");
    return `https://r.jina.ai/http://${stripped}`;
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
    const res = await axios.get(url, {
        responseType: "text",
        headers: {
            "User-Agent": UA,
            Accept: "*/*",
            ...headers,
        },
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 400, // follow redirects via axios
        maxRedirects: 5,
    });
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

type ExtractDepth = "basic" | "advanced";

function extractReadableHtml(
    html: string,
    baseUrl: string
): { title?: string; contentHtml?: string; meta?: Record<string, string> } {
    const dom = new JSDOM(html, { url: baseUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return {};
    // article.content is sanitized HTML, article.textContent is plain text
    const doc = dom.window.document;
    const meta: Record<string, string> = {};
    const getMeta = (sel: string, attr: string) => doc.querySelector(sel)?.getAttribute(attr) || "";
    meta["url"] = baseUrl;
    meta["title"] = article.title || "";
    meta["author"] = getMeta('meta[name="author"]', "content") || getMeta('meta[property="article:author"]', "content");
    meta["published"] =
        getMeta('meta[property="article:published_time"]', "content") ||
        getMeta("time[datetime]", "datetime") ||
        getMeta('meta[name="date"]', "content");
    return {
        title: article.title ?? undefined,
        contentHtml: article.content ?? undefined,
        meta,
    };
}

// Try to infer the language from class names like "language-ts", "lang-js", "language-javascript"
function detectCodeLang(el: Element | null | undefined): string {
    const cls = (el?.getAttribute("class") || "").toLowerCase();
    const candidates = [
        /language-([a-z0-9#+-]+)/i,
        /lang-?([a-z0-9#+-]+)/i,
        /highlight-([a-z0-9#+-]+)/i,
        /language_([a-z0-9#+-]+)/i,
    ];
    for (const re of candidates) {
        const m = cls.match(re);
        if (m && m[1]) return m[1];
    }
    return "";
}

function normalizeMarkdown(md: string): string {
    // Ensure blank line before headings
    md = md.replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2");
    // Ensure a blank line before list blocks (supports indented lists; not between items)
    md = md.replace(/(^|\n)([^\n-#>].*?)\n(?=[\t ]*(?:- |\d+\. ))/gm, "$1$2\n\n");
    // Ensure a blank line after list blocks (supports indented lists; not between items)
    md = md.replace(/((?:[\t ]*(?:- |\d+\. ).+))\n(?!(?:[\t ]*(?:- |\d+\. )|[\t ]*#{1,6}\s|[\t ]*> |\s*$))/g, "$1\n\n");
    // Collapse blank lines between consecutive list items (supports indented lists)
    md = md.replace(/(^[\t ]*(?:[-*+]|\d+\.)\s+.+)\n(?:[\t ]*\n)+(?!\n)(?=^[\t ]*(?:[-*+]|\d+\.)\s+)/gm, "$1\n");
    // Compact excessive blank lines
    md = md.replace(/\n{3,}/g, "\n\n");
    // Trim trailing spaces
    md = md.replace(/[ \t]+$/gm, "");
    // Ensure file ends with single newline
    md = md.trimEnd() + "\n";
    return md;
}

function resolveUrl(baseUrl: string, href: string): string {
    try {
        return new URL(href, baseUrl).toString();
    } catch {
        return href;
    }
}

function absolutizeLinks(html: string, baseUrl: string): string {
    try {
        const dom = new JSDOM(html, { url: baseUrl });
        dom.window.document.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href") || "";
            if (!href) return;
            a.setAttribute("href", resolveUrl(baseUrl, href));
        });
        dom.window.document.querySelectorAll("img[src]").forEach((img) => {
            const src = img.getAttribute("src") || "";
            if (!src) return;
            img.setAttribute("src", resolveUrl(baseUrl, src));
        });
        return dom.serialize();
    } catch {
        return html;
    }
}

function htmlToMarkdown(html: string, baseUrl?: string, depth: ExtractDepth = "basic"): string {
    const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
        emDelimiter: "*",
        strongDelimiter: "**",
        fence: "```",
    });

    // GitHub Flavored Markdown (tables, strikethrough, task lists)
    // @ts-ignore - plugin types are not provided
    turndown.use(gfm);

    // Remove unwanted elements
    turndown.addRule("removeScriptsStyles", {
        filter: ["script", "style", "noscript"],
        replacement: () => "",
    });

    // Images → keep alt and absolute URL when possible, auto-number missing alt for advanced depth
    turndown.addRule("imageWithAlt", {
        filter: "img",
        replacement: (_content, node: any) => {
            const alt = (node.getAttribute("alt") || "").trim();
            const src = (node.getAttribute("src") || "").trim();
            if (!src) return alt ? `![${alt}]()` : "";
            let finalAlt = alt;
            if (!finalAlt && depth === "advanced") {
                const idx = (node as any).__imgIndex ?? 0;
                finalAlt = `Image ${idx || 1}`;
            }
            return finalAlt ? `![${finalAlt}](${src})` : `![](${src})`;
        },
    });

    // Figures with captions → image + caption as emphasized text
    turndown.addRule("figureWithCaption", {
        filter: "figure",
        replacement: (_content, node: any) => {
            const fig = node as HTMLElement;
            const img = fig.querySelector("img");
            const caption = fig.querySelector("figcaption")?.textContent?.trim();
            if (!img) return "";
            const alt = (img.getAttribute("alt") || "").trim();
            const src = (img.getAttribute("src") || "").trim();
            const imgMd = alt ? `![${alt}](${src})` : `![](${src})`;
            return caption ? `${imgMd}\n\n*${caption}*` : imgMd;
        },
    });

    // Helper to reconstruct code text including explicit <br> tags
    function extractCodeText(node: Element): string {
        const owner = node.ownerDocument || (node as any).document || undefined;
        const inner = (node as HTMLElement).innerHTML || "";
        if (/\bbr\b/i.test(inner)) {
            if (owner) {
                const tmp = owner.createElement("div");
                tmp.innerHTML = inner.replace(/<br\s*\/?\s*>/gi, "\n");
                return tmp.textContent || node.textContent || "";
            }
            return inner.replace(/<br\s*\/?\s*>/gi, "\n");
        }
        return node.textContent || "";
    }

    // Preserve pre/code blocks with language if detectable (only for <pre>)
    turndown.addRule("fencedPreCodeWithLanguage", {
        filter: (node) => node.nodeName === "PRE",
        replacement: (_content, node: any) => {
            const codeEl = node.querySelector("code") || node;
            const lang = detectCodeLang(codeEl);
            let codeText = extractCodeText(codeEl);
            // Normalize line endings and strip trailing newline
            codeText = codeText.replace(/\r\n/g, "\n").replace(/\n+$/g, "");

            // Heuristic: if code appears minified into a single line but contains
            // multiple statements/tokens, try to restore basic newlines.
            if (!/\n/.test(codeText) && codeText.length > 60) {
                codeText = codeText
                    .replace(/;\s*/g, ";\n")
                    .replace(/\)\s*\{/g, ") {\n")
                    .replace(/\}\s*\)/g, "}\n)")
                    .replace(/\}\s*;?/g, "}\n")
                    .replace(/\)\s*;?/g, ")\n")
                    .replace(/\n{2,}/g, "\n");
                // Place comment lines on their own
                codeText = codeText.replace(/\s*\/\/\s?/g, "\n// ");
                codeText = codeText.replace(/\n{2,}/g, "\n");
            }

            // Short single token pre blocks → inline code
            if (!/\n/.test(codeText) && codeText.trim().length < 40) {
                const inline = codeText.trim().replace(/`/g, "\u0060");
                return " `" + inline + "` ";
            }
            const fence = "```";
            return `\n\n${fence}${lang ? " " + lang : ""}\n${codeText}\n${fence}\n\n`;
        },
    });

    // Inline <code> not inside <pre> → inline backticks
    turndown.addRule("inlineCode", {
        filter: (node) => node.nodeName === "CODE" && (node as Element).closest("pre") == null,
        replacement: (content, node: any) => {
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (!text) return "";
            // Escape backticks inside
            const safe = text.replace(/`/g, "\u0060");
            return "`" + safe + "`";
        },
    });

    // Blockquotes: ensure a blank line before
    turndown.addRule("blockquoteSpacing", {
        filter: "blockquote",
        replacement: (content) => `\n\n> ${content.replace(/\n/g, "\n> ").trim()}\n\n`,
    });

    // Optionally absolutize links for advanced depth
    const sourceHtml = depth === "advanced" && baseUrl ? absolutizeLinks(html, baseUrl) : html;

    // Convert to MD
    let md = turndown.turndown(sourceHtml);

    // Normalize spacing/newlines
    md = normalizeMarkdown(md);
    return md;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[`*_~]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
}

function stripExistingHeadingAnchors(line: string): string {
    // Remove trailing anchor links like [​](... "Direct link to ...")
    return line.replace(/\s*\[​\]\([^)]*?Direct link[^)]*\)\s*$/i, "");
}

function addHeadingAnchors(md: string, baseUrl: string): string {
    const lines = md.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
        if (!m) continue;
        const level = m[1];
        let title = m[2].trim();
        // Remove any existing [​](...) anchors appended
        title = stripExistingHeadingAnchors(title);
        const anchor = slugify(title);
        const abs = `http://${new URL(baseUrl).host}${new URL(baseUrl).pathname}#${anchor}`;
        lines[i] = `${level} ${title}[​](${abs} "Direct link to ${title}")`;
    }
    return lines.join("\n");
}

function buildJinaStyleHeader(meta?: Record<string, string>): string {
    if (!meta) return "";
    const urlHttp = meta.url ? meta.url.replace(/^https:\/\//i, "http://") : "";
    const parts: string[] = [];
    if (meta.title) parts.push(`Title: ${meta.title}`);
    if (urlHttp) parts.push(`URL Source: ${urlHttp}`);
    if (meta.published) parts.push(`Published Time: ${meta.published}`);
    return parts.join("\n\n") + "\n\nMarkdown Content:\n";
}

function buildExtractedMarkdown(html: string, srcUrl: string, depth: ExtractDepth = "basic"): string {
    const { title, contentHtml, meta } = extractReadableHtml(html, srcUrl);
    let bodyMd = "";
    if (contentHtml) {
        bodyMd = htmlToMarkdown(contentHtml, srcUrl, depth);
    } else {
        // Fallback to whole page conversion
        bodyMd = htmlToMarkdown(html, srcUrl, depth);
    }

    let out = bodyMd.trim();
    if (depth === "advanced") {
        // Add anchors to headings (absolute URL anchor style)
        out = addHeadingAnchors(out, srcUrl);
        // Jina header at top and drop H1 (if any)
        const header = buildJinaStyleHeader({
            ...(meta as Record<string, string> | undefined),
            url: srcUrl,
            title: title || meta?.title || "",
        });
        out = `${header}\n${out}`;
    } else {
        // Basic: keep H1 at top if missing
        if (title && !/^#\s+/m.test(out)) {
            out = `# ${title}\n\n${out}`;
        }
    }
    return normalizeMarkdown(out);
}

function renderUnifiedDiff(oldLabel: string, newLabel: string, oldStr: string, newStr: string): string {
    const patch = createTwoFilesPatch(oldLabel, newLabel, oldStr, newStr, "", "", { context: 3 });
    const lines = patch.split("\n");
    return (
        lines
            .map((line) => {
                if (line.startsWith("+++ ") || line.startsWith("--- ")) return chalk.cyan(line);
                if (line.startsWith("@@")) return chalk.yellow(line);
                if (line.startsWith("+") && !line.startsWith("+++")) return chalk.green(line);
                if (line.startsWith("-") && !line.startsWith("---")) return chalk.red(line);
                if (line.startsWith("\\")) return chalk.gray(line);
                return line;
            })
            .join("\n") + "\n"
    );
}

// Token helpers
function countTokens(text: string): number {
    try {
        return encode(text).length;
    } catch {
        // Fallback: rough estimate
        return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
    }
}

function limitToTokens(text: string, maxTokens?: number): { text: string; tokens: number } {
    if (!maxTokens || maxTokens <= 0) {
        return { text, tokens: countTokens(text) };
    }
    try {
        const ids = encode(text);
        const sliced = ids.slice(0, maxTokens);
        const out = decode(sliced);
        return { text: out, tokens: sliced.length };
    } catch {
        const words = text.split(/\s+/);
        const out = words.slice(0, maxTokens).join(" ");
        return { text: out, tokens: Math.min(maxTokens, words.length) };
    }
}

// Save tokens by compacting code blocks (trim trailing spaces, collapse blank lines)
function compactCodeBlocks(markdown: string): string {
    const lines = markdown.split("\n");
    const result: string[] = [];
    let inFence = false;
    let fence = "```";
    let buffer: string[] = [];

    function flushBuffer() {
        // Remove trailing spaces, collapse multiple blank lines
        const out: string[] = [];
        let lastBlank = false;
        for (let line of buffer) {
            line = line.replace(/[ \t]+$/g, "");
            const isBlank = line.trim().length === 0;
            if (isBlank) {
                if (!lastBlank) out.push("");
                lastBlank = true;
            } else {
                out.push(line);
                lastBlank = false;
            }
        }
        result.push(...out);
        buffer = [];
    }

    for (const line of lines) {
        if (!inFence && /^`{3,}/.test(line)) {
            inFence = true;
            fence = line.match(/^`{3,}/)?.[0] || "```";
            result.push(line.replace(/[ \t]+$/g, ""));
            continue;
        }
        if (inFence && line.startsWith(fence)) {
            flushBuffer();
            result.push(line.replace(/[ \t]+$/g, ""));
            inFence = false;
            continue;
        }
        if (inFence) buffer.push(line);
        else result.push(line.replace(/[ \t]+$/g, ""));
    }
    if (buffer.length) flushBuffer();
    return result.join("\n");
}

// CLI options interface
interface CliOptions {
    url: string;
    mode: string;
    depth: string;
    out?: string;
    tokens?: string;
    saveTokens: boolean;
    headers?: string;
}

// CLI
async function runCli(opts: CliOptions) {
    const url = ensureHttpUrl(String(opts.url));
    const mode = opts.mode;
    const depth = (opts.depth || "basic") as ExtractDepth;
    const out = opts.out;
    const maxTokens = opts.tokens ? Number(opts.tokens) : undefined;
    const saveTokens = opts.saveTokens;

    try {
        if (mode === "raw") {
            log.info(`Fetching raw HTML: ${chalk.cyan(url)}`);
            const headers = opts.headers ? JSON.parse(String(opts.headers)) : undefined;
            let html = await fetchText(url, headers);
            if (saveTokens) html = html.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
            const limited = limitToTokens(html, maxTokens);
            if (out) {
                await Bun.write(out, limited.text);
                log.ok(`Wrote HTML to ${out}`);
            } else {
                process.stdout.write(limited.text + "\n");
            }
            return;
        }

        if (mode === "jina") {
            const jUrl = buildJinaUrl(url);
            log.info(`Fetching Jina Reader MD: ${chalk.cyan(jUrl)}`);
            let md = await fetchText(jUrl);
            if (saveTokens) md = compactCodeBlocks(md);
            const limited = limitToTokens(md, maxTokens);
            if (out) {
                await Bun.write(out, limited.text);
                log.ok(`Wrote Jina MD to ${out}`);
            } else {
                process.stdout.write(limited.text + "\n");
            }
            return;
        }

        if (mode === "markdown") {
            log.info(`Fetching HTML and extracting locally: ${chalk.cyan(url)}`);
            const html = await fetchText(url);
            let md = buildExtractedMarkdown(html, url, depth);
            if (saveTokens) md = compactCodeBlocks(md);
            const limited = limitToTokens(md, maxTokens);
            if (out) {
                await Bun.write(out, limited.text);
                log.ok(`Wrote extracted MD to ${out}`);
            } else {
                process.stdout.write(limited.text + "\n");
            }
            return;
        }

        log.err(`Unknown mode: ${mode} (expected raw|markdown|jina)`);
        process.exit(1);
    } catch (e) {
        log.err("Failed", e);
        process.exit(1);
    }
}

// MCP server
const server = new Server(
    {
        name: "mcp-web-reader",
        version: "0.1.0",
    },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "FetchWebRaw",
                description: "Fetch raw HTML of a URL (depth, save_tokens, tokens)",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        headers: { type: "object", description: "Optional headers" },
                        depth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth" },
                        save_tokens: {
                            type: "number",
                            enum: [0, 1],
                            description: "Compact code blocks to save tokens",
                        },
                        tokens: { type: "number", description: "Max tokens to return" },
                    },
                    required: ["url"],
                },
            },
            {
                name: "FetchJina",
                description:
                    "Fetch Markdown via Jina Reader (https://r.jina.ai/http://...) (depth, save_tokens, tokens)",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        depth: {
                            type: "string",
                            enum: ["basic", "advanced"],
                            description: "Extraction depth (info only)",
                        },
                        save_tokens: {
                            type: "number",
                            enum: [0, 1],
                            description: "Compact code blocks to save tokens",
                        },
                        tokens: { type: "number", description: "Max tokens to return" },
                    },
                    required: ["url"],
                },
            },
            {
                name: "FetchWebMarkdown",
                description: "Extract Markdown locally using Readability + Turndown (depth, save_tokens, tokens)",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        depth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth" },
                        save_tokens: {
                            type: "number",
                            enum: [0, 1],
                            description: "Compact code blocks to save tokens",
                        },
                        tokens: { type: "number", description: "Max tokens to return" },
                    },
                    required: ["url"],
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;

    try {
        if (name === "FetchWebRaw") {
            const url = ensureHttpUrl(String(args.url));
            const headers = (args.headers || undefined) as Record<string, string> | undefined;
            const _depth = (args.depth as ExtractDepth) || "basic"; // not used for raw
            const saveTokens = Number(args.save_tokens) === 1;
            const maxTokens = typeof args.tokens === "number" ? (args.tokens as number) : undefined;
            let html = await fetchText(url, headers);
            if (saveTokens) html = html.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
            const limited = limitToTokens(html, maxTokens);
            return { content: [{ type: "text", text: limited.text }], meta: { tokens: String(limited.tokens) } as any };
        }

        if (name === "FetchJina") {
            const url = ensureHttpUrl(String(args.url));
            const saveTokens = Number(args.save_tokens) === 1;
            const maxTokens = typeof args.tokens === "number" ? (args.tokens as number) : undefined;
            let md = await fetchText(buildJinaUrl(url));
            if (saveTokens) md = compactCodeBlocks(md);
            const limited = limitToTokens(md, maxTokens);
            return { content: [{ type: "text", text: limited.text }], meta: { tokens: String(limited.tokens) } as any };
        }

        if (name === "FetchWebMarkdown") {
            const url = ensureHttpUrl(String(args.url));
            const depth = (args.depth as ExtractDepth) || "basic";
            const saveTokens = Number(args.save_tokens) === 1;
            const maxTokens = typeof args.tokens === "number" ? (args.tokens as number) : undefined;
            const html = await fetchText(url);
            let md = buildExtractedMarkdown(html, url, depth);
            if (saveTokens) md = compactCodeBlocks(md);
            const limited = limitToTokens(md, maxTokens);
            return { content: [{ type: "text", text: limited.text }], meta: { tokens: String(limited.tokens) } as any };
        }

        return Object.create(null);
    } catch (e: any) {
        return {
            isError: true,
            content: [{ type: "text", text: `Error: ${e?.message || String(e)}` }],
        };
    }
});

async function main() {
    const program = new Command()
        .name("mcp-web-reader")
        .description("Web content reader (MCP + CLI)")
        .option("-u, --url <url>", "Source URL (required)")
        .option("-m, --mode <mode>", "raw | markdown | jina (required)")
        .option("-d, --depth <depth>", "Extraction depth: basic | advanced", "basic")
        .option("-T, --tokens <n>", "Max AI tokens to return")
        .option("-s, --save-tokens", "Compact code blocks and whitespace")
        .option("-o, --out <path>", "Output file path")
        .option("--headers <json>", "Additional request headers as JSON")
        .option("--server", "Start as MCP server instead of CLI")
        .parse();

    const opts = program.opts();

    if (opts.server) {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("mcp-web-reader server running");
        return;
    }

    if (!opts.url) {
        log.err("--url is required");
        process.exit(1);
    }
    if (!opts.mode) {
        log.err("--mode is required (raw | markdown | jina)");
        process.exit(1);
    }

    await runCli({
        url: opts.url,
        mode: opts.mode,
        depth: opts.depth || "basic",
        out: opts.out,
        tokens: opts.tokens,
        saveTokens: opts.saveTokens || false,
        headers: opts.headers,
    });
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});

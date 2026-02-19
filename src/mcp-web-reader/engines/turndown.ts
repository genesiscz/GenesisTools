import { gfm } from "@truto/turndown-plugin-gfm";
import TurndownService from "turndown";
import { extractContent } from "@app/mcp-web-reader/utils/extraction.js";
import { resolveUrl } from "@app/mcp-web-reader/utils/urls.js";
import { MarkdownEngine } from "./base.js";
import type { ConversionOptions, ConversionResult, EngineName } from "./types.js";

export class TurndownEngine extends MarkdownEngine {
    name: EngineName = "turndown";
    description = "Turndown with GFM plugin - highly customizable, good for complex documents";

    private service: TurndownService;

    constructor() {
        super();
        this.service = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            fence: "```",
            bulletListMarker: "-",
            emDelimiter: "*",
            strongDelimiter: "**",
        });

        // Add GFM plugin for tables, strikethrough, task lists
        this.service.use(gfm);

        // Custom rules
        this.addCustomRules();
    }

    private addCustomRules(): void {
        // Remove scripts/styles
        this.service.remove(["script", "style", "noscript", "iframe"]);

        // Enhanced code block with language detection
        this.service.addRule("fencedCodeBlock", {
            filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
            replacement: (_content, node) => {
                const codeEl = (node as Element).querySelector("code");
                const lang = this.detectLanguage(codeEl);
                const code = this.extractCodeText(codeEl);
                return `\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
            },
        });

        // Links with validation - store baseUrl in instance for access
        this.service.addRule("validatedLink", {
            filter: "a",
            replacement: (content, node) => {
                const href = (node as Element).getAttribute("href");
                if (!href || href.startsWith("javascript:") || href.startsWith("#")) {
                    return content;
                }
                const cleanContent = content.replace(/\s+/g, " ").trim();
                if (!cleanContent) return "";
                // Use the stored baseUrl from options
                const url = resolveUrl((this as TurndownEngineWithBaseUrl).currentBaseUrl || "", href);
                return `[${cleanContent}](${url})`;
            },
        });

        // Figure with caption
        this.service.addRule("figureCaption", {
            filter: "figure",
            replacement: (_content, node) => {
                const img = (node as Element).querySelector("img");
                const caption = (node as Element).querySelector("figcaption");
                if (!img) return _content;
                const src = img.getAttribute("src") || "";
                const alt = img.getAttribute("alt") || "";
                let result = `![${alt}](${src})`;
                if (caption?.textContent?.trim()) {
                    result += `\n*${caption.textContent.trim()}*`;
                }
                return `\n${result}\n\n`;
            },
        });

        // Inline code
        this.service.addRule("inlineCode", {
            filter: (node) => node.nodeName === "CODE" && !(node as Element).closest("pre"),
            replacement: (_content, node) => {
                const text = ((node as Element).textContent || "").replace(/\s+/g, " ").trim();
                if (!text) return "";
                const safe = text.replace(/`/g, "\u0060");
                return `\`${safe}\``;
            },
        });
    }

    private detectLanguage(el: Element | null): string {
        if (!el) return "";
        const classes = `${el.className} ${el.parentElement?.className || ""}`;
        const patterns = [/language-(\w+)/i, /lang-(\w+)/i, /highlight-(\w+)/i, /brush:\s*(\w+)/i];
        for (const p of patterns) {
            const m = classes.match(p);
            if (m) return this.normalizeLanguage(m[1]);
        }
        return "";
    }

    private normalizeLanguage(lang: string): string {
        const aliases: Record<string, string> = {
            js: "javascript",
            ts: "typescript",
            py: "python",
            rb: "ruby",
            sh: "bash",
            yml: "yaml",
        };
        return aliases[lang.toLowerCase()] || lang.toLowerCase();
    }

    private extractCodeText(el: Element | null): string {
        if (!el) return "";
        // Convert <br> to newlines, strip other HTML
        let text = el.innerHTML.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
        // Decode HTML entities
        text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        return text.trim();
    }

    async convert(html: string, options: ConversionOptions): Promise<ConversionResult> {
        const start = performance.now();

        // Extract main content
        const extraction = extractContent(html, options.baseUrl);

        // Store baseUrl for link resolution
        (this as TurndownEngineWithBaseUrl).currentBaseUrl = options.baseUrl;

        // Convert
        let markdown = this.service.turndown(extraction.content);

        // Normalize
        markdown = this.normalize(markdown);

        // Add metadata header for advanced mode
        if (options.depth === "advanced" && extraction.meta.title) {
            const header = this.buildHeader(extraction.meta, options.baseUrl);
            markdown = header + markdown;
        }

        return {
            markdown,
            metadata: extraction.meta,
            metrics: {
                inputChars: html.length,
                outputChars: markdown.length,
                conversionTimeMs: performance.now() - start,
            },
        };
    }

    private buildHeader(meta: Record<string, string | undefined>, url: string): string {
        const lines = ["---"];
        if (meta.title) lines.push(`title: ${meta.title}`);
        lines.push(`url: ${url}`);
        if (meta.author) lines.push(`author: ${meta.author}`);
        if (meta.publishedTime) lines.push(`date: ${meta.publishedTime}`);
        lines.push("---\n\n");
        return lines.join("\n");
    }
}

// Type augmentation for storing baseUrl
interface TurndownEngineWithBaseUrl extends TurndownEngine {
    currentBaseUrl?: string;
}

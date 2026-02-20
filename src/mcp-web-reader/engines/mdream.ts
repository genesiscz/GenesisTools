import { extractContent } from "@app/mcp-web-reader/utils/extraction.js";
import { htmlToMarkdown } from "mdream";
import { MarkdownEngine } from "./base.js";
import type { ConversionOptions, ConversionResult, EngineName } from "./types.js";

export class MdreamEngine extends MarkdownEngine {
    name: EngineName = "mdream";
    description = "mdream - 3x faster, ~50% fewer tokens, optimized for LLMs";

    async convert(html: string, options: ConversionOptions): Promise<ConversionResult> {
        const start = performance.now();

        // Extract main content first
        const extraction = extractContent(html, options.baseUrl);

        // Convert with mdream
        let markdown = htmlToMarkdown(extraction.content);

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

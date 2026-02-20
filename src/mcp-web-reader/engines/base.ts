import type { ConversionOptions, ConversionResult, EngineName, ValidationResult } from "./types.js";

export abstract class MarkdownEngine {
    abstract name: EngineName;
    abstract description: string;

    abstract convert(html: string, options: ConversionOptions): Promise<ConversionResult>;

    // Shared validation logic
    validate(markdown: string): ValidationResult {
        const htmlTags = (markdown.match(/<[a-z][^>]*>/gi) || []).length;
        const emptyLinks = (markdown.match(/\[\s*\]\(\s*\)/g) || []).length;
        const codeBlocks = (markdown.match(/```/g) || []).length;
        const unclosed = codeBlocks % 2 !== 0;

        const issues: string[] = [];
        if (htmlTags > 0) issues.push(`${htmlTags} HTML tags remaining`);
        if (emptyLinks > 0) issues.push(`${emptyLinks} empty links`);
        if (unclosed) issues.push("Unclosed code block detected");

        return {
            valid: issues.length === 0,
            issues,
            htmlTagsRemaining: htmlTags,
            emptyLinks,
            unclosedCodeBlocks: unclosed,
        };
    }

    // Shared normalization
    normalize(markdown: string): string {
        return `${markdown
            // Fix link text whitespace
            .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, text, url) => `[${text.replace(/\s+/g, " ").trim()}](${url})`)
            // Heading spacing
            .replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2")
            // List spacing
            .replace(/([^\n])\n([-*] |\d+\. )/g, "$1\n\n$2")
            // Collapse newlines
            .replace(/\n{3,}/g, "\n\n")
            // Trim lines
            .split("\n")
            .map((l) => l.trimEnd())
            .join("\n")
            .trimEnd()}\n`;
    }
}

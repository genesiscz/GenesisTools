export interface ValidationResult {
    valid: boolean;
    issues: string[];
    metrics: {
        htmlTagsRemaining: number;
        emptyLinks: number;
        unclosedCodeBlocks: boolean;
        brokenImages: number;
    };
}

export function validateMarkdown(markdown: string): ValidationResult {
    const issues: string[] = [];

    // Check for remaining HTML tags (excluding allowed ones like <br>)
    const htmlTags = (markdown.match(/<(?!br)[a-z][^>]*>/gi) || []).length;
    if (htmlTags > 0) {
        issues.push(`${htmlTags} HTML tags remaining in output`);
    }

    // Check for empty links
    const emptyLinks = (markdown.match(/\[\s*\]\(\s*\)/g) || []).length;
    if (emptyLinks > 0) {
        issues.push(`${emptyLinks} empty links found`);
    }

    // Check for unclosed code blocks
    const codeBlocks = (markdown.match(/```/g) || []).length;
    const unclosed = codeBlocks % 2 !== 0;
    if (unclosed) {
        issues.push("Unclosed code block detected");
    }

    // Check for broken image syntax
    const brokenImages = (markdown.match(/!\[[^\]]*\]\(\s*\)/g) || []).length;
    if (brokenImages > 0) {
        issues.push(`${brokenImages} images with empty src`);
    }

    return {
        valid: issues.length === 0,
        issues,
        metrics: {
            htmlTagsRemaining: htmlTags,
            emptyLinks,
            unclosedCodeBlocks: unclosed,
            brokenImages,
        },
    };
}

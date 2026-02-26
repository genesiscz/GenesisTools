// Quote deduplication logic for GitHub comments

const MAX_QUOTE_LINES = 5;

/**
 * Extract quoted text from a comment body
 */
export function extractQuotes(body: string): { quote: string; startLine: number; endLine: number }[] {
    const lines = body.split("\n");
    const quotes: { quote: string; startLine: number; endLine: number }[] = [];

    let currentQuote: string[] = [];
    let quoteStartLine = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith(">")) {
            if (quoteStartLine === -1) {
                quoteStartLine = i;
            }
            // Remove the leading '>' and optional space
            currentQuote.push(line.replace(/^>\s?/, ""));
        } else {
            if (currentQuote.length > 0) {
                quotes.push({
                    quote: currentQuote.join("\n"),
                    startLine: quoteStartLine,
                    endLine: i - 1,
                });
                currentQuote = [];
                quoteStartLine = -1;
            }
        }
    }

    // Handle quote at end of comment
    if (currentQuote.length > 0) {
        quotes.push({
            quote: currentQuote.join("\n"),
            startLine: quoteStartLine,
            endLine: lines.length - 1,
        });
    }

    return quotes;
}

/**
 * Truncate a quote if it exceeds max lines
 */
export function truncateQuote(quote: string, maxLines: number = MAX_QUOTE_LINES): string {
    const lines = quote.split("\n");
    if (lines.length <= maxLines) {
        return quote;
    }

    return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

/**
 * Process comment body to deduplicate/truncate quotes
 */
export function processQuotes(
    body: string,
    maxQuoteLines: number = MAX_QUOTE_LINES,
): {
    processedBody: string;
    hadTruncatedQuotes: boolean;
} {
    const lines = body.split("\n");
    const result: string[] = [];
    let hadTruncatedQuotes = false;

    let quoteLines: string[] = [];
    let inQuote = false;

    for (const line of lines) {
        if (line.startsWith(">")) {
            if (!inQuote) {
                inQuote = true;
                quoteLines = [];
            }
            quoteLines.push(line);
        } else {
            if (inQuote) {
                // End of quote block
                if (quoteLines.length > maxQuoteLines) {
                    // Truncate and add indicator
                    result.push(...quoteLines.slice(0, maxQuoteLines));
                    result.push("> ...");
                    hadTruncatedQuotes = true;
                } else {
                    result.push(...quoteLines);
                }
                inQuote = false;
                quoteLines = [];
            }
            result.push(line);
        }
    }

    // Handle quote at end
    if (inQuote && quoteLines.length > 0) {
        if (quoteLines.length > maxQuoteLines) {
            result.push(...quoteLines.slice(0, maxQuoteLines));
            result.push("> ...");
            hadTruncatedQuotes = true;
        } else {
            result.push(...quoteLines);
        }
    }

    return {
        processedBody: result.join("\n"),
        hadTruncatedQuotes,
    };
}

/**
 * Find which comment a quote might be replying to
 */
export function findReplyTarget(quoteText: string, previousComments: { id: number; body: string }[]): number | null {
    if (!quoteText || previousComments.length === 0) {
        return null;
    }

    // Normalize quote text for comparison
    const normalizedQuote = normalizeText(quoteText);

    // Search backwards through comments (most recent first)
    for (let i = previousComments.length - 1; i >= 0; i--) {
        const comment = previousComments[i];
        const normalizedBody = normalizeText(comment.body);

        // Check if quote appears in this comment
        if (normalizedBody.includes(normalizedQuote)) {
            return comment.id;
        }

        // Also check partial matches for truncated quotes
        const quoteLines = normalizedQuote.split("\n").filter((l) => l.trim());
        if (quoteLines.length > 0) {
            const firstLine = quoteLines[0];
            if (normalizedBody.includes(firstLine) && firstLine.length > 20) {
                return comment.id;
            }
        }
    }

    return null;
}

/**
 * Normalize text for comparison
 */
function normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Detect cross-references in issue/PR body
 */
export function detectCrossReferences(body: string): {
    type: "fixes" | "closes" | "related";
    number: number;
}[] {
    const refs: { type: "fixes" | "closes" | "related"; number: number }[] = [];

    // Patterns: Fixes #123, Closes #456, Related: #789, etc.
    const patterns = [
        { regex: /(?:fix(?:es)?|fixed)\s*:?\s*#(\d+)/gi, type: "fixes" as const },
        { regex: /(?:close[sd]?)\s*:?\s*#(\d+)/gi, type: "closes" as const },
        { regex: /(?:related(?:\s+to)?|relates?\s+to|see)\s*:?\s*#(\d+)/gi, type: "related" as const },
        { regex: /(?:resolve[sd]?)\s*:?\s*#(\d+)/gi, type: "closes" as const },
    ];

    for (const { regex, type } of patterns) {
        let match = regex.exec(body);
        while (match !== null) {
            const number = parseInt(match[1], 10);
            // Avoid duplicates
            if (!refs.some((r) => r.number === number)) {
                refs.push({ type, number });
            }
            match = regex.exec(body);
        }
    }

    // Also catch standalone #123 references as 'related'
    const standaloneRefs = body.match(/(?<![a-zA-Z])#(\d+)(?![a-zA-Z])/g);
    if (standaloneRefs) {
        for (const ref of standaloneRefs) {
            const number = parseInt(ref.slice(1), 10);
            if (!refs.some((r) => r.number === number)) {
                refs.push({ type: "related", number });
            }
        }
    }

    return refs;
}

/**
 * Utility for formatting MCP response content consistently
 */

/**
 * Formats content for MCP text response with optional syntax highlighting
 * @param content - The content to format (string or object)
 * @param format - Format type: "json" for JSON code fence, "text" for plain text, "auto" to detect
 * @returns Formatted string for MCP text content
 */
export function formatTextContent(content: string | Record<string, any>, format: "json" | "text" | "auto" = "auto"): string {
    // Auto-detect format
    if (format === "auto") {
        format = typeof content === "object" ? "json" : "text";
    }

    if (format === "json") {
        const jsonString = typeof content === "string" ? content : JSON.stringify(content, null, 2);
        return `\`\`\`json\n${jsonString}\n\`\`\``;
    }

    // Plain text (with backticks for better readability if it contains special characters)
    const textString = typeof content === "object" ? JSON.stringify(content, null, 2) : content;

    // If it's a multi-line string or contains formatting, wrap in code fence
    if (textString.includes("\n") || textString.includes("```")) {
        return `\`\`\`\n${textString}\n\`\`\``;
    }

    return textString;
}

/**
 * Creates a standard MCP error response content
 */
export function formatErrorContent(message: string): Array<{ type: "text"; text: string }> {
    return [
        {
            type: "text",
            text: `\`\`\`\nError: ${message}\n\`\`\``,
        },
    ];
}

/**
 * Creates a standard MCP success response content
 */
export function formatSuccessContent(content: string | Record<string, any>, format?: "json" | "text" | "auto"): Array<{ type: "text"; text: string }> {
    return [
        {
            type: "text",
            text: formatTextContent(content, format),
        },
    ];
}

import os from "os";
import pathUtils from "path";

/**
 * Replaces the home directory with a tilde.
 * @param path - The path to tildeify.
 * @returns The tildeified path.
 */
export function tildeifyPath(path: string): string {
    const homeDir = os.homedir();
    if (path.startsWith(homeDir)) {
        return path.replace(homeDir, "~");
    }
    return path;
}

export function resolvePathWithTilde(path: string): string {
    if (path.startsWith("~")) {
        return path.replace("~", os.homedir());
    }

    return pathUtils.resolve(path, "~");
}

/**
 * Normalizes file path(s) from various formats that MCP tools might receive.
 * Handles:
 * - Arrays: `["file1.ts", "file2.ts"]`
 * - JSON array strings: `'["file1.ts", "file2.ts"]'`
 * - Python-style array strings: `"['file1.ts', 'file2.ts']"`
 * - Single strings: `"file.ts"`
 *
 * @param input - The input value which could be a string, array, or array-like string
 * @returns An array of file paths/patterns
 */
export function normalizeFilePaths(input: string | string[] | unknown): string[] {
    // Already an array
    if (Array.isArray(input)) {
        return input.filter((item): item is string => typeof item === "string");
    }

    // Not a string, return empty array
    if (typeof input !== "string") {
        return [];
    }

    const trimmed = input.trim();

    // Check if it looks like an array string (starts with [ and ends with ])
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        // Try parsing as JSON first (handles double-quoted strings)
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.filter((item): item is string => typeof item === "string");
            }
        } catch {
            // JSON.parse failed, try handling Python-style arrays (single quotes)
            try {
                // Convert single quotes to double quotes for JSON compatibility
                const pythonToJson = trimmed.replace(/'/g, '"');
                const parsed = JSON.parse(pythonToJson);
                if (Array.isArray(parsed)) {
                    return parsed.filter((item): item is string => typeof item === "string");
                }
            } catch {
                // Both JSON parsing attempts failed, manually parse the array
                // Extract content between brackets, handling both single and double quotes
                const match = trimmed.match(/\[(.*)\]/s);
                if (match) {
                    const content = match[1].trim();
                    if (content) {
                        // Split by comma and clean up quotes
                        const items = content
                            .split(",")
                            .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
                            .filter((item) => item.length > 0);
                        if (items.length > 0) {
                            return items;
                        }
                    }
                }
            }
        }
    }

    // Not an array string, treat as single file path
    return [trimmed];
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const INDEX_FILE_NAMES = ["index.ts", "index.tsx"];
const SCRIPT_EXTENSIONS = [".ts", ".tsx"];

export interface ToolInfo {
    name: string;
    description: string;
    hasReadme: boolean;
    path: string;
}

/**
 * Scan src/ directory and discover all available tools.
 */
export function discoverTools(srcDir: string): ToolInfo[] {
    const tools: ToolInfo[] = [];
    if (!existsSync(srcDir)) return tools;
    const entries = readdirSync(srcDir);

    for (const entry of entries) {
        const entryPath = join(srcDir, entry);
        try {
            const stats = statSync(entryPath);
            if (stats.isDirectory()) {
                const indexFile = INDEX_FILE_NAMES.find((f) => existsSync(join(entryPath, f)));
                if (indexFile) {
                    tools.push({
                        name: entry,
                        description: extractDescription(entryPath),
                        hasReadme: existsSync(join(entryPath, "README.md")),
                        path: join(entryPath, indexFile),
                    });
                }
            } else if (
                stats.isFile() &&
                SCRIPT_EXTENSIONS.some((ext) => entry.endsWith(ext)) &&
                !INDEX_FILE_NAMES.includes(entry)
            ) {
                const ext = SCRIPT_EXTENSIONS.find((e) => entry.endsWith(e))!;
                const name = basename(entry, ext);
                const toolDir = join(srcDir, name);
                tools.push({
                    name,
                    description: extractDescription(toolDir),
                    hasReadme: existsSync(join(toolDir, "README.md")),
                    path: entryPath,
                });
            }
        } catch {
            // skip entries with errors
        }
    }

    return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract description from README.md first meaningful line after title.
 * Falls back to humanized name from directory.
 */
function extractDescription(toolDir: string): string {
    const readmePath = join(toolDir, "README.md");
    if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("#")) continue;
            if (trimmed.startsWith("---")) continue;
            if (trimmed.startsWith("![")) continue;
            if (trimmed.startsWith("[![")) continue;
            return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
        }
    }

    // Fallback: humanize the directory/tool name
    const name = basename(toolDir) || "Unknown";
    return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get the README content for a tool, or null if not available.
 */
export function getReadme(srcDir: string, toolName: string): string | null {
    const readmePath = join(srcDir, toolName, "README.md");
    if (existsSync(readmePath)) {
        return readFileSync(readmePath, "utf-8");
    }
    return null;
}

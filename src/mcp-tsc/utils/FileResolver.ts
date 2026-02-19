import { glob } from "glob";
import path from "node:path";
import ts from "typescript";

/**
 * Resolve file patterns (files, directories, globs) to actual file paths
 */
export async function resolveFiles(patterns: string[], cwd: string = process.cwd()): Promise<string[]> {
    const files = new Set<string>();

    for (const pattern of patterns) {
        const absolutePath = path.resolve(cwd, pattern);

        // Check if it's a directory
        if (ts.sys.directoryExists(absolutePath)) {
            const dirPattern = path.join(pattern, "**/*.{ts,tsx,js,jsx}").replace(/\\/g, "/");
            const matches = await glob(dirPattern, {
                cwd: cwd,
                absolute: false,
                ignore: ["**/node_modules/**", "**/*.d.ts", "**/dist/**", "**/build/**"],
            });
            matches.forEach((file) => files.add(path.resolve(cwd, file)));
        }
        // Check if it's a glob pattern
        else if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[") || pattern.includes("{")) {
            const matches = await glob(pattern, {
                cwd: cwd,
                absolute: false,
                ignore: ["**/node_modules/**", "**/*.d.ts"],
            });
            matches.forEach((file) => files.add(path.resolve(cwd, file)));
        }
        // Check if it's a direct file path
        else if (ts.sys.fileExists(absolutePath)) {
            files.add(absolutePath);
        } else {
            console.warn(`Warning: File or directory not found: ${pattern}`);
        }
    }

    return Array.from(files);
}

/**
 * Filter files based on tsconfig.json inclusion
 */
export function filterByTsconfig(targetFiles: string[], cwd: string = process.cwd()): string[] {
    const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (!configPath) {
        console.error("tsconfig.json not found");
        return [];
    }

    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
    const tsconfigFiles = new Set(parsed.fileNames.map((f) => path.resolve(f)));

    return targetFiles.filter((f) => tsconfigFiles.has(path.resolve(f)));
}

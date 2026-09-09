import { basename, relative, sep } from "node:path";
import { resolveProjectNameFromEncoded } from "@genesiscz/utils/claude/projects";
import type { NativeSessionSource } from "../types";

export function isClaudeSubagentPath(path: string): boolean {
    return path.split(sep).includes("subagents") || basename(path).startsWith("agent-");
}

export function claudeNativeId(source: Pick<NativeSessionSource<string>, "root" | "filePath">): string {
    if (!isClaudeSubagentPath(source.filePath)) {
        return basename(source.filePath, ".jsonl");
    }

    return relative(source.root, source.filePath)
        .split(sep)
        .join("/")
        .replace(/\.jsonl$/, "");
}

export function claudeProjectDirectory(
    source: Pick<NativeSessionSource<string>, "root" | "filePath">
): string | undefined {
    const parts = relative(source.root, source.filePath).split(sep);

    if (parts.length > 1 && parts[0] && parts[0] !== "..") {
        return parts[0];
    }

    const rootName = basename(source.root);
    return rootName.startsWith("-") ? rootName : undefined;
}

export function claudeProjectName(options: {
    source: NativeSessionSource<string>;
    cwd?: string | null;
}): string | null {
    const directory = claudeProjectDirectory(options.source);

    if (directory) {
        return resolveProjectNameFromEncoded(directory);
    }

    const cwd = options.cwd ?? options.source.metadata?.cwd;
    return options.source.metadata?.project ?? (cwd ? basename(cwd) : null);
}

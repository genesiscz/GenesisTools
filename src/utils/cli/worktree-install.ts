import { statSync } from "node:fs";
import { join } from "node:path";

/** Linked checkouts do not auto-install; unreadable markers fail closed unless explicitly opted in. */
export function skipWorktreeInstall({
    workspaceRoot,
    autoInstall,
    stat = statSync,
}: {
    workspaceRoot: string;
    autoInstall?: string;
    stat?: (path: string) => { isFile(): boolean };
}): boolean {
    if (autoInstall === "1") {
        return false;
    }

    try {
        return stat(join(workspaceRoot, ".git")).isFile();
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            return false;
        }

        throw error;
    }
}

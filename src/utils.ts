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

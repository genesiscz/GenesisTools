import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function nativeNeedsBuild({ binary, sourceDir }: { binary: string; sourceDir: string }): boolean {
    const roots = ["Package.swift", "Sources", "SnapshotSupport"].map((path) => join(sourceDir, path));

    if (!existsSync(binary) || roots.some((path) => !existsSync(path))) {
        return true;
    }

    const built = statSync(binary).mtimeMs;
    const newer = (path: string): boolean => {
        if (!existsSync(path)) {
            return false;
        }

        const stat = statSync(path);

        if (stat.isDirectory()) {
            return stat.mtimeMs > built || readdirSync(path).some((name) => newer(join(path, name)));
        }

        return path.endsWith(".swift") && stat.mtimeMs > built;
    };
    return roots.some(newer);
}

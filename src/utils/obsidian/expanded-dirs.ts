import { normalizeVaultPath } from "@app/utils/obsidian/paths";

/** Parent directory paths required to reveal `relativePath` (file or folder). */
export function ancestorDirs(relativePath: string): string[] {
    const normalized = normalizeVaultPath(relativePath);
    const parts = normalized.split("/").filter(Boolean);

    if (parts.length <= 1) {
        return [];
    }

    const dirs: string[] = [];

    for (let i = 1; i < parts.length; i++) {
        dirs.push(parts.slice(0, i).join("/"));
    }

    return dirs;
}

export function parseOpenDirs(raw: string | undefined): Set<string> {
    if (!raw) {
        return new Set();
    }

    return new Set(
        raw
            .split(",")
            .map((segment) => decodeURIComponent(segment.trim()))
            .filter(Boolean)
            .map(normalizeVaultPath)
    );
}

export function serializeOpenDirs(dirs: Iterable<string>): string | undefined {
    const list = [...dirs].map(normalizeVaultPath).filter(Boolean).sort();

    if (list.length === 0) {
        return undefined;
    }

    return list.map(encodeURIComponent).join(",");
}

export function expandedDirsForNote(notePath: string, existing: Iterable<string> = []): Set<string> {
    const next = new Set(existing);

    for (const dir of ancestorDirs(notePath)) {
        next.add(dir);
    }

    return next;
}

export function expandedDirsForFolderToggle(dir: string, expanded: boolean, existing: Iterable<string>): Set<string> {
    const next = new Set(existing);

    if (expanded) {
        for (const parent of ancestorDirs(dir)) {
            next.add(parent);
        }

        next.add(normalizeVaultPath(dir));
    } else {
        next.delete(normalizeVaultPath(dir));
    }

    return next;
}

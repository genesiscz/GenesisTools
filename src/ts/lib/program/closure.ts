import type { FileCost, GraphFile, GraphResult } from "./types";

/** The package a declaration file belongs to (the innermost node_modules segment), or null for a project file. */
export function packageOf(path: string): string | null {
    const marker = "node_modules/";
    const at = path.lastIndexOf(marker);

    if (at < 0 || (at > 0 && path[at - 1] !== "/")) {
        return null;
    }

    const [first, second] = path.slice(at + marker.length).split("/");

    if (!first || second === undefined) {
        return null;
    }

    return first.startsWith("@") ? `${first}/${second}` : first;
}

/** A project file's folder: `src/<tool>`, `packages/<name>`, or its first path segment. */
export function folderOf(path: string): string | null {
    if (packageOf(path) || path.startsWith("/")) {
        return null;
    }

    const parts = path.split("/");

    if ((parts[0] === "src" || parts[0] === "packages") && parts.length > 2) {
        return `${parts[0]}/${parts[1]}`;
    }

    return parts.length > 1 ? (parts[0] ?? null) : "(top-level files)";
}

function closureOf(files: GraphFile[], starts: Iterable<number>): Set<number> {
    const seen = new Set<number>();
    const stack = [...starts];

    while (stack.length) {
        const at = stack.pop();

        if (at === undefined || seen.has(at)) {
            continue;
        }

        seen.add(at);

        for (const next of files[at]?.imports ?? []) {
            stack.push(next);
        }
    }

    return seen;
}

export interface FolderClosure {
    folder: string;
    /** The folder's own root files. */
    own: number;
    /** Every file a tsconfig that includes only this folder would hold. */
    files: number;
    bytes: number;
    nodeModulesFiles: number;
    /** Files of the project's other folders that it pulls in. */
    otherFolderFiles: number;
}

export interface ClosureOptions {
    /**
     * Count the project's own root declaration files as part of every folder's program, as a per-folder tsconfig that
     * includes `../**\/*.d.ts` would (ambient declarations nothing imports). Default true.
     */
    ambient?: boolean;
}

/** For each folder, what a program of only that folder's files would hold (default libraries and `types` included). */
export function folderClosures(graph: GraphResult, options: ClosureOptions = {}): FolderClosure[] {
    const files = graph.files;
    const base = files.flatMap((file, i) =>
        file.base || (options.ambient !== false && file.root && file.declaration && !packageOf(file.path)) ? [i] : []
    );
    const folders = new Map<string, number[]>();

    for (const [i, file] of files.entries()) {
        const folder = file.root && !file.base ? folderOf(file.path) : null;

        if (folder) {
            folders.set(folder, [...(folders.get(folder) ?? []), i]);
        }
    }

    const rows = [...folders].map(([folder, own]) => {
        const reach = closureOf(files, [...own, ...base]);
        let bytes = 0;
        let nodeModulesFiles = 0;
        let otherFolderFiles = 0;

        for (const at of reach) {
            const file = files[at];

            if (!file) {
                continue;
            }

            bytes += file.bytes;

            if (packageOf(file.path)) {
                nodeModulesFiles++;
            } else if (folderOf(file.path) !== folder && !file.base) {
                otherFolderFiles++;
            }
        }

        return { folder, own: own.length, files: reach.size, bytes, nodeModulesFiles, otherFolderFiles };
    });

    return rows.sort((a, b) => b.bytes - a.bytes);
}

export interface PackageSize {
    name: string;
    files: number;
    bytes: number;
    /** Project files that import the package directly. */
    importers: string[];
}

/** Declaration packages by size, each with the project files that import it directly. */
export function packageSizes(graph: GraphResult): PackageSize[] {
    const sizes = new Map<string, PackageSize>();

    for (const file of graph.files) {
        const name = packageOf(file.path);

        if (!name) {
            continue;
        }

        const size = sizes.get(name) ?? { name, files: 0, bytes: 0, importers: [] };
        size.files++;
        size.bytes += file.bytes;
        sizes.set(name, size);
    }

    for (const file of graph.files) {
        if (packageOf(file.path)) {
            continue;
        }

        for (const at of file.imports) {
            const name = packageOf(graph.files[at]?.path ?? "");
            const size = name ? sizes.get(name) : undefined;

            if (size && !size.importers.includes(file.path)) {
                size.importers.push(file.path);
            }
        }
    }

    return [...sizes.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * The shortest import chain from a project file to the first file whose path contains `needle` (a package name or
 * part of a path), or null when no project file reaches it.
 */
export function whyChain(graph: GraphResult, needle: string): string[] | null {
    const files = graph.files;
    const target = files.findIndex((file) => file.path.includes(needle));

    if (target < 0) {
        return null;
    }

    const importers = new Map<number, number[]>();

    for (const [i, file] of files.entries()) {
        for (const at of file.imports) {
            importers.set(at, [...(importers.get(at) ?? []), i]);
        }
    }

    const previous = new Map<number, number>([[target, -1]]);
    const queue = [target];

    for (let head = 0; head < queue.length; head++) {
        const at = queue[head];

        if (at === undefined) {
            continue;
        }

        if (!packageOf(files[at]?.path ?? "") && files[at]?.base !== true) {
            const chain: string[] = [];

            for (let step = at; step >= 0; step = previous.get(step) ?? -1) {
                chain.push(files[step]?.path ?? "?");
            }

            return chain;
        }

        for (const from of importers.get(at) ?? []) {
            if (!previous.has(from)) {
                previous.set(from, at);
                queue.push(from);
            }
        }
    }

    return null;
}

export interface FolderCost {
    folder: string;
    files: number;
    types: number;
    instantiations: number;
    symbols: number;
    ms: number;
}

/** Per-file check costs summed per folder. */
export function costByFolder(rows: FileCost[]): FolderCost[] {
    const folders = new Map<string, FolderCost>();

    for (const row of rows) {
        const folder = folderOf(row.file) ?? "(outside)";
        const cost = folders.get(folder) ?? { folder, files: 0, types: 0, instantiations: 0, symbols: 0, ms: 0 };
        cost.files++;
        cost.types += row.types;
        cost.instantiations += row.instantiations;
        cost.symbols += row.symbols;
        cost.ms += row.ms;
        folders.set(folder, cost);
    }

    return [...folders.values()];
}

export interface DuplicatePackage {
    name: string;
    /** Each installed copy: its folder, files and bytes in the program. */
    copies: Array<{ folder: string; files: number; bytes: number }>;
    /** Bytes of every copy after the largest: what deduplicating would take out of the program. */
    extraBytes: number;
}

/** Packages whose declarations are in the program from more than one installed copy (nested node_modules). */
export function duplicatePackages(graph: GraphResult): DuplicatePackage[] {
    const copies = new Map<string, Map<string, { files: number; bytes: number }>>();

    for (const file of graph.files) {
        const name = packageOf(file.path);

        if (!name) {
            continue;
        }

        const at = file.path.lastIndexOf(`node_modules/${name}/`);
        const folder = file.path.slice(0, at + `node_modules/${name}`.length);
        const byFolder = copies.get(name) ?? new Map();
        const copy = byFolder.get(folder) ?? { files: 0, bytes: 0 };
        copy.files++;
        copy.bytes += file.bytes;
        byFolder.set(folder, copy);
        copies.set(name, byFolder);
    }

    const rows: DuplicatePackage[] = [];

    for (const [name, byFolder] of copies) {
        if (byFolder.size < 2) {
            continue;
        }

        const list = [...byFolder].map(([folder, copy]) => ({ folder, ...copy })).sort((a, b) => b.bytes - a.bytes);
        rows.push({ name, copies: list, extraBytes: list.slice(1).reduce((sum, copy) => sum + copy.bytes, 0) });
    }

    return rows.sort((a, b) => b.extraBytes - a.extraBytes);
}

import { dirname, join } from "node:path";

/**
 * An import specifier resolved to a repository file, or null.
 *
 * A relative specifier is joined to the importing file's folder; any other one is taken as written,
 * because a monorepo may import by repository path (`packages/…`). A package name is never a
 * repository file, so it resolves to null. The candidates are tried in the order TypeScript uses:
 * `.ts`, `.tsx`, `index.ts`, `index.tsx`, and the specifier exactly as written last. `exists` decides
 * what counts as a file: a set of tracked paths, or a check on disk. Without `from`, a relative
 * specifier is null.
 */
export function resolveSpecifier({
    from,
    specifier,
    exists,
}: {
    from?: string;
    specifier: string;
    exists: (path: string) => boolean;
}): string | null {
    let base = specifier;

    if (specifier.startsWith(".")) {
        if (from === undefined) {
            return null;
        }

        base = join(dirname(from), specifier);
    }

    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base]) {
        if (exists(candidate)) {
            return candidate;
        }
    }

    return null;
}

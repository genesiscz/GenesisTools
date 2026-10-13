/**
 * `webpack:///../packages/x/y.ts` -> `packages/x/y.ts`: the repo-relative tail a map source points at. A webpack
 * namespace in front of a relative path (`webpack://my-app/./src/a.ts`) and inner `/./` segments are dropped too.
 */
export function sourceTail(source: string): string {
    return source
        .replace(/^[a-z-]+:\/\/\/?/i, "")
        .replace(/^[^/]+\/(?=\.\.?\/)/, "")
        .replace(/^(?:\.\.?\/)+/, "")
        .replace(/\/(?:\.\/)+/g, "/")
        .replace(/\?.*$/, "");
}

/**
 * Tracked files a map source names, preferring ones under `preferDir`. A relative source matches every tracked
 * path that ends with it (`src/App.tsx` -> `web/src/App.tsx`); an absolute one (a build in another checkout)
 * matches the longest tracked path it ends with.
 */
export function repoPathsFor(options: { source: string; tracked: string[]; preferDir?: string }): string[] {
    const tail = sourceTail(options.source);
    if (!tail) {
        return [];
    }

    let matches = options.tracked.filter((path) => path === tail || path.endsWith(`/${tail}`));
    if (matches.length === 0) {
        const suffixes = options.tracked.filter((path) => tail.endsWith(`/${path}`));
        const longest = Math.max(0, ...suffixes.map((path) => path.length));
        matches = suffixes.filter((path) => path.length === longest);
    }

    const preferred = options.preferDir ? matches.filter((path) => path.startsWith(`${options.preferDir}/`)) : [];
    return preferred.length > 0 ? preferred : matches;
}

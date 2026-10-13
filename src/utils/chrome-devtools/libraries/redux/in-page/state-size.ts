export interface ReduxStateArgs {
    /** The window property holding the Redux store, as set by `findReactProps` with `exposeAs`. */
    slot: string;
    /** How deep to split the state into slices: 1 = top-level keys, 2 = their children. Default 2. */
    depth?: number;
    /** Keep only the largest slices. Default 50. */
    top?: number;
    /** Dotted state paths whose values are returned as they are (for example "billings.receivedPayments"). */
    exportPaths?: string[];
}

export interface ReduxSliceSize {
    path: string;
    /** UTF-8 bytes of `JSON.stringify(value)`; -1 when the value does not serialize. */
    bytes: number;
}

export interface ReduxStateSize {
    /** UTF-8 bytes of the whole state; -1 when it does not serialize. */
    bytes: number;
    slices: ReduxSliceSize[];
    exported: Record<string, unknown>;
    error?: string;
}

/**
 * Measures the Redux state of the store kept on `window[slot]`, split into slices by path, largest
 * first, and optionally returns chosen slices. Read-only. Self-contained: only its source text reaches
 * the page.
 */
export function reduxStateSize(args: ReduxStateArgs): ReduxStateSize {
    const result: ReduxStateSize = { bytes: -1, slices: [], exported: {} };
    const store = (window as unknown as Record<string, unknown>)[args.slot] as { getState?: () => unknown } | undefined;
    if (!store || typeof store.getState !== "function") {
        result.error = `window.${args.slot} holds no Redux store`;
        return result;
    }

    const depth = Math.max(1, args.depth ?? 2);
    const encoder = new TextEncoder();
    const size = (value: unknown): number => {
        try {
            // biome-ignore lint/style/noRestrictedGlobals: in-page code runs in the browser and cannot import SafeJSON
            return encoder.encode(JSON.stringify(value ?? null) ?? "null").length;
        } catch {
            return -1;
        }
    };

    const isBranch = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);

    const state = store.getState();
    result.bytes = size(state);

    const walk = (value: unknown, path: string, level: number): void => {
        if (level < depth && isBranch(value) && Object.keys(value).length > 0) {
            for (const [key, child] of Object.entries(value)) {
                walk(child, path ? `${path}.${key}` : key, level + 1);
            }

            return;
        }

        result.slices.push({ path, bytes: size(value) });
    };

    if (isBranch(state)) {
        for (const [key, child] of Object.entries(state)) {
            walk(child, key, 1);
        }
    }

    result.slices.sort((a, b) => b.bytes - a.bytes);
    result.slices = result.slices.slice(0, args.top ?? 50);

    for (const path of args.exportPaths ?? []) {
        let current: unknown = state;
        for (const segment of path.split(".")) {
            current =
                isBranch(current) || Array.isArray(current) ? (current as Record<string, unknown>)[segment] : undefined;
        }

        result.exported[path] = current === undefined ? null : current;
    }

    return result;
}

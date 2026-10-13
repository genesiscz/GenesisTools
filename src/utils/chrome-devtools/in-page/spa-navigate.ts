export interface SpaNavigateArgs {
    /** Path, or a full URL of the same origin. */
    path: string;
    /** Replace the history entry instead of pushing a new one. */
    replace?: boolean;
}

export interface SpaNavigateResult {
    from: string;
    to: string;
}

/**
 * Moves a single-page app to `path` without a reload: `history.pushState` (or `replaceState`) plus a
 * `popstate` event, which routers such as React Router listen to. App state and caches survive.
 * Throws for another origin, which needs a real navigation. Self-contained: only its source reaches the page.
 */
export function spaNavigate(args: SpaNavigateArgs): SpaNavigateResult {
    const from = location.pathname + location.search + location.hash;
    const url = new URL(args.path, location.href);
    if (url.origin !== location.origin) {
        throw new Error(`spaNavigate stays on ${location.origin}; ${url.origin} needs a real navigation`);
    }

    if (args.replace) {
        history.replaceState(history.state, "", url.href);
    } else {
        history.pushState(null, "", url.href);
    }

    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    return { from, to: url.pathname + url.search + url.hash };
}

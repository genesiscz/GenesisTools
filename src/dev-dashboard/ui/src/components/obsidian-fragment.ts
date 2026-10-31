import { useEffect } from "react";

/** A URL fragment as an element id; a malformed escape (`#100%`) is used as written instead of throwing. */
function fragmentId(hash: string): string {
    try {
        return decodeURIComponent(hash);
    } catch {
        return hash;
    }
}

/**
 * Scrolls the note to the fragment's element. A heading inside a folded callout (`details.ts` renders it closed) is
 * opened first, or there is nothing to see.
 */
export function revealFragment(doc: Document, hash: string): void {
    const target = doc.getElementById(fragmentId(hash));

    if (!target) {
        return;
    }

    for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) {
        fold.open = true;
    }

    target.scrollIntoView({ block: "start" });
}

/**
 * Reveals the route's fragment (`hash`, without its `#`) once the article is mounted, and again for every new
 * fragment: a link to another heading of the open note changes only the hash, and TanStack's own hash scroll opens
 * no fold. It also runs again when reading mode mounts the article, so a fragment restored with source mode on
 * still scrolls.
 */
export function useRevealFragment({ hash, html, mounted }: { hash: string; html?: string; mounted: boolean }): void {
    useEffect(() => {
        if (!html || !hash || !mounted) {
            return;
        }

        revealFragment(document, hash);
    }, [hash, html, mounted]);
}

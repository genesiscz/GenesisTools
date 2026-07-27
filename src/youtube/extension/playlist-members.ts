/** Pure playlist-membership helpers (testable without a YouTube page). */

/**
 * Pick the member video ids out of a playlist page's anchor hrefs.
 *
 * Matching on the URL rather than on a renderer tag is deliberate: detection
 * used to query `ytd-playlist-video-renderer`, and when YouTube re-rendered
 * playlists as `yt-lockup-view-model` the panel silently reported "0 videos
 * detected" forever. Member links always carry `?v=…&list=<id>`, which survives
 * those custom-element renames.
 *
 * Anchors for a *different* list (sidebar shelves, "next playlist" links) are
 * skipped, so a stray recommendation can't inflate the report.
 */
export function playlistVideoIdsFromHrefs(hrefs: Iterable<string>, listId: string, max: number): string[] {
    const ids: string[] = [];

    for (const href of hrefs) {
        let url: URL;

        try {
            url = new URL(href, "https://www.youtube.com");
        } catch {
            continue;
        }

        if (url.searchParams.get("list") !== listId) {
            continue;
        }

        const id = url.searchParams.get("v");

        if (!id || ids.includes(id)) {
            continue;
        }

        ids.push(id);

        if (ids.length >= max) {
            break;
        }
    }

    return ids;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

import { logger } from "@genesiscz/utils/logger";
import { type BrowserSurfaceOptions, createBrowserSurface } from "../loop/browser";
import type { SurfaceCandidate, SurfaceSnapshot } from "../loop/surface";
import type { PrefetchPayload } from "../prefetch";
import type { ListenSurface, ListenView } from "./pipeline";
import type { ListenCandidate } from "./verbs";

const { log } = logger.scoped("jev-listen-chrome");

export interface BrowserListenSurface extends ListenSurface {
    close(): Promise<void>;
}

/**
 * The CDP page as a listen surface. The accessibility map a browser exposes to the DevTools
 * Protocol is the one an AX walk cannot reach: a real page nests deeper than ax-tool's ceiling and
 * carries more rows than a snapshot may hold, so a native observation of a browser can only ever
 * show the tab strip and toolbar. Here the rows are the page's own nodes, named and referenced by
 * uid, which is what makes "open that profile" a choosable thing at all.
 */
export function createBrowserListenSurface(options: BrowserSurfaceOptions): BrowserListenSurface {
    const surface = createBrowserSurface(options);
    let last: SurfaceSnapshot | undefined;
    return {
        async see(): Promise<ListenView> {
            const snapshot = await surface.see();
            last = snapshot;
            log.info(
                { page: snapshot.label.slice(0, 80), candidates: snapshot.candidates.length },
                "browser listen surface snapshot"
            );
            return {
                app: "browser",
                window: snapshot.label,
                snapshot: snapshot.id,
                candidates: snapshot.candidates.map(toListenCandidate),
                rows: evidenceRows(snapshot),
            };
        },
        async act(payload: PrefetchPayload) {
            if (!last) {
                return { ok: false, error: "no page snapshot yet; the surface has not been observed" };
            }

            const candidate = findCandidate(last.candidates, payload);
            if (!candidate) {
                return { ok: false, error: "payload is not a row of the current page snapshot" };
            }

            return surface.act(last, candidate, payload);
        },
        close: () => surface.close(),
    };
}

/**
 * A page label alone is often a whole sentence of chrome ("name, game, Live, 8.7k viewers"), and
 * the thing a spoken "open <name>" actually means is the link target. Naming it keeps the choice
 * grounded in something the page asserts rather than in how the label happens to read.
 */
function labelFor(candidate: SurfaceCandidate): string {
    if (candidate.href === undefined) {
        return candidate.label;
    }

    const path = pathOf(candidate.href);
    return path === undefined || candidate.label.includes(path) ? candidate.label : `${candidate.label} → ${path}`;
}

function pathOf(href: string): string | undefined {
    try {
        const url = new URL(href);
        const path = `${url.host}${url.pathname}`.replace(/\/$/, "");
        return path.length > 0 ? path : undefined;
    } catch (error) {
        log.debug({ href, error }, "link target is not a parseable URL; leaving the label alone");
        return undefined;
    }
}

function toListenCandidate(candidate: SurfaceCandidate): ListenCandidate {
    return {
        id: candidate.id,
        label: labelFor(candidate),
        action: candidate.action === "click" ? "press" : candidate.action === "set" ? "set" : "chrome",
        element: candidate.element,
        ...(candidate.chrome === undefined ? {} : { chrome: candidate.chrome as ListenCandidate["chrome"] }),
    };
}

/** A page row is identified by its uid; `element` is -1 for every one of them. */
function findCandidate(candidates: SurfaceCandidate[], payload: PrefetchPayload): SurfaceCandidate | undefined {
    if (payload.uid !== undefined) {
        return candidates.find((item) => item.id === payload.uid);
    }

    if (payload.chrome !== undefined) {
        return candidates.find((item) => item.chrome === payload.chrome);
    }

    return undefined;
}

function evidenceRows(snapshot: SurfaceSnapshot): { id: string; role: string; label: string }[] {
    return snapshot.candidates.map((candidate) => ({
        id: candidate.id,
        role: candidate.role ?? candidate.action,
        label: candidate.label.slice(0, 300),
    }));
}

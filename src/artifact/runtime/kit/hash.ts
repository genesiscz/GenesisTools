import { useEffect } from "react";

/**
 * The URL hash is shared by several kit components: `Tabs` owns one plain
 * segment (the tab id) and each `TimeSeries` with an `id` owns a
 * `ts.<id>=<state>` segment. Segments are joined with "&":
 *
 *   #misses&ts.context=r%3D1~2&ts.cost=l%3Dsplit
 *
 * Every writer replaces only its own segment and keeps the rest, so a tab deep
 * link and a chart's saved view survive each other's updates.
 */

/** A chart segment is `ts.<key>=`; anything else (a tab id) is a plain segment. */
export function isChartSegment(segment: string): boolean {
    return /^ts\.[^=&]*=/.test(segment);
}

/** A named component state has an equals sign; encoded tab ids never do. */
function isNamedSegment(segment: string): boolean {
    return /^[^=]+=/.test(segment);
}

export function hashSegments(hash: string): string[] {
    const body = hash.replace(/^#/, "");

    return body ? body.split("&").filter(Boolean) : [];
}

/** Plain segments first, chart segments after, as one hash ("" when empty). */
export function composeHash(segments: readonly string[]): string {
    const plain = segments.filter((s) => !isNamedSegment(s));
    const charts = segments.filter(isNamedSegment);
    const all = [...plain, ...charts];

    return all.length ? `#${all.join("&")}` : "";
}

/** The first plain segment, still URL-encoded ("" when the hash carries only chart segments). */
export function plainSegment(hash: string): string {
    return hashSegments(hash).find((s) => !isNamedSegment(s)) ?? "";
}

/** Replace the plain segment (the tab id, already encoded) and keep every chart segment. */
export function withPlainSegment(hash: string, encoded: string): string {
    const charts = hashSegments(hash).filter(isNamedSegment);

    return composeHash(encoded ? [encoded, ...charts] : charts);
}

/**
 * The decoded plain segment when the hash ALSO carries named state (`#layers&d=…` gives "layers"), else "".
 * A lone `#layers` is left to the browser, which scrolls to it by itself.
 */
export function sectionAnchor(hash: string): string {
    const segments = hashSegments(hash);
    const plain = segments.find((s) => !isNamedSegment(s));

    if (!plain || !segments.some(isNamedSegment)) {
        return "";
    }

    try {
        return decodeURIComponent(plain);
    } catch {
        return plain;
    }
}

const revealedOnLoad = new WeakSet<Document>();
/** Mounted users of useSectionAnchor per window; the window keeps one hashchange listener while any is mounted. */
const anchorUsers = new WeakMap<Window, number>();

function revealSectionAnchor(): void {
    const id = sectionAnchor(window.location.hash);

    if (id) {
        document.getElementById(id)?.scrollIntoView();
    }
}

/**
 * Keep section deep links working for a component that stores its state in the hash. The browser looks the WHOLE
 * fragment up as an element id, so `#layers&d=…` scrolls nowhere. On the first mount in a document, and on every
 * hash navigation, scroll to the element the plain segment names. Only the first mount scrolls, so a component
 * that mounts later (inside a tab the reader opens) does not move the page. Every mounted user shares one
 * listener, so a hash change scrolls once, however many components ask for it.
 */
export function useSectionAnchor(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) {
            return;
        }

        if (!revealedOnLoad.has(document)) {
            revealedOnLoad.add(document);
            revealSectionAnchor();
        }

        const win = window;
        const users = anchorUsers.get(win) ?? 0;
        anchorUsers.set(win, users + 1);

        if (users === 0) {
            win.addEventListener("hashchange", revealSectionAnchor);
        }

        return () => {
            const left = (anchorUsers.get(win) ?? 1) - 1;
            anchorUsers.set(win, left);

            if (left === 0) {
                win.removeEventListener("hashchange", revealSectionAnchor);
            }
        };
    }, [enabled]);
}

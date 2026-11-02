import type { LatLon } from "./types";

/**
 * Waze's official, public deep links (https://developers.google.com/waze/deeplinks). They open the Waze app on a phone
 * and the live map in a desktop browser.
 */
const UL = "https://waze.com/ul";
const LIVE_MAP = "https://www.waze.com/live-map/directions";

export function navigateLink(to: LatLon, opts: { navigate?: boolean; zoom?: number } = {}): string {
    const params = new URLSearchParams({ ll: `${to.lat.toFixed(6)},${to.lon.toFixed(6)}` });
    if (opts.navigate !== false) {
        params.set("navigate", "yes");
    }

    if (opts.zoom !== undefined) {
        params.set("z", String(opts.zoom));
    }

    return `${UL}?${params}`;
}

/** A search deep link: Waze resolves the text itself (`?q=`). */
export function searchLink(query: string, opts: { navigate?: boolean } = {}): string {
    const params = new URLSearchParams({ q: query });
    if (opts.navigate) {
        params.set("navigate", "yes");
    }

    return `${UL}?${params}`;
}

/** The live map in a browser with a route from `from` to `to` drawn (the page's own directions URL). */
export function liveMapDirectionsLink(from: LatLon, to: LatLon): string {
    const params = new URLSearchParams({
        from: `ll.${from.lat.toFixed(6)},${from.lon.toFixed(6)}`,
        to: `ll.${to.lat.toFixed(6)},${to.lon.toFixed(6)}`,
    });
    return `${LIVE_MAP}?${params}`;
}

/** The live map centred on a point (the page reads `ll` like the deep link). */
export function liveMapLink(at: LatLon, zoom = 15): string {
    const params = new URLSearchParams({ ll: `${at.lat.toFixed(6)},${at.lon.toFixed(6)}`, zoom: String(zoom) });
    return `https://www.waze.com/live-map/?${params}`;
}

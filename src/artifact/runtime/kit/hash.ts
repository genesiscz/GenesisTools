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

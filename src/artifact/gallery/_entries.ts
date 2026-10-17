// The kit gallery's page list, as plain data and pure functions. The browser index groups and filters it,
// and `tools artifact gallery` reads the same list to print it and to resolve a page name, so both agree.
import type { ComponentType } from "react";

/** Families in nav order. A page whose family is not listed lands in "Other", after these. */
export const GALLERY_FAMILIES = [
    "Layout",
    "Data",
    "Evidence",
    "Markdown",
    "Diagrams",
    "Diff",
    "Structure",
    "Viz",
    "Charts",
    "Planning",
    "Forms",
    "Interactive",
    "Router",
] as const;

export type GalleryFamily = (typeof GALLERY_FAMILIES)[number];

/** What a page module exports besides its default component. */
export interface GalleryMeta {
    title: string;
    family: GalleryFamily;
    summary?: string;
    /** Kit components the page demonstrates; the nav search and the CLI name matcher look at them. */
    components?: string[];
}

export interface GalleryPageModule {
    default?: ComponentType;
    meta?: GalleryMeta;
}

export interface GalleryEntry {
    id: string;
    title: string;
    family: string;
    summary?: string;
    components: string[];
    Component: ComponentType;
}

export interface GalleryGroup {
    family: string;
    entries: GalleryEntry[];
}

/** Turn "./filter-chips.tsx" into the id "filter-chips"; the title falls back to "Filter chips". */
export function galleryEntries(modules: Record<string, GalleryPageModule>): GalleryEntry[] {
    const entries: GalleryEntry[] = [];

    for (const [path, mod] of Object.entries(modules)) {
        const id = path
            .replace(/^.*[/\\]/, "")
            .replace(/^\.\//, "")
            .replace(/\.tsx$/, "");

        if (id === "index" || id.startsWith("_") || !mod.default) {
            continue;
        }

        const fallback = id.replace(/-/g, " ");
        entries.push({
            id,
            title: mod.meta?.title ?? fallback.charAt(0).toUpperCase() + fallback.slice(1),
            family: mod.meta?.family ?? "Other",
            summary: mod.meta?.summary,
            components: mod.meta?.components ?? [],
            Component: mod.default,
        });
    }

    return entries.sort((a, b) => familyRank(a.family) - familyRank(b.family) || a.title.localeCompare(b.title));
}

const FAMILY_RANK = new Map<string, number>(GALLERY_FAMILIES.map((family, index) => [family, index]));

function familyRank(family: string): number {
    return FAMILY_RANK.get(family) ?? GALLERY_FAMILIES.length;
}

/** Resolve the query route, accepting old hash links without throwing on truncated escapes. */
export function galleryPageId(entries: GalleryEntry[], url: URL): string {
    const fromQuery = url.searchParams.get("page") ?? "";
    let fromHash = url.hash.slice(1);

    try {
        fromHash = decodeURIComponent(fromHash);
    } catch {
        // A malformed legacy link cannot name a gallery page; fall back below.
    }

    return [fromQuery, fromHash].find((id) => entries.some((entry) => entry.id === id)) ?? entries[0]?.id ?? "";
}

/** Entries grouped by family, in nav order; `galleryEntries` already sorted them. */
export function groupByFamily(entries: GalleryEntry[]): GalleryGroup[] {
    const groups: GalleryGroup[] = [];

    for (const entry of entries) {
        const last = groups[groups.length - 1];

        if (last?.family === entry.family) {
            last.entries.push(entry);
        } else {
            groups.push({ family: entry.family, entries: [entry] });
        }
    }

    return groups;
}

/** Lowercase letters and digits only, so "Time series", "time-series" and "TimeSeries" compare equal. */
export function normalizeGalleryQuery(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
    let at = 0;

    for (const ch of haystack) {
        if (ch === needle[at]) {
            at++;
        }

        if (at === needle.length) {
            return true;
        }
    }

    return false;
}

/** How well `query` (already normalized) names `entry`: 0 is no match, higher is better. */
export function galleryMatchScore(entry: GalleryEntry, query: string): number {
    if (!query) {
        return 0;
    }

    const names = [entry.id, entry.title, ...entry.components].map(normalizeGalleryQuery);
    const family = normalizeGalleryQuery(entry.family);
    let best = 0;

    for (const name of names) {
        if (name === query) {
            best = Math.max(best, 100);
        } else if (name.startsWith(query)) {
            best = Math.max(best, 80);
        } else if (name.includes(query)) {
            best = Math.max(best, 60);
        }
    }

    if (family === query) {
        best = Math.max(best, 50);
    }

    if (best === 0 && normalizeGalleryQuery(entry.summary ?? "").includes(query)) {
        best = 20;
    }

    if (best === 0 && query.length >= 3 && names.some((name) => isSubsequence(query, name))) {
        best = 10;
    }

    return best;
}

/** The page a free-text name means (`gantt`, `time series`, `datatable`), or undefined. Ties keep nav order. */
export function matchGalleryEntry(entries: GalleryEntry[], query: string): GalleryEntry | undefined {
    const normalized = normalizeGalleryQuery(query);
    let best: GalleryEntry | undefined;
    let bestScore = 0;

    for (const entry of entries) {
        const score = galleryMatchScore(entry, normalized);

        if (score > bestScore) {
            best = entry;
            bestScore = score;
        }
    }

    return best;
}

/** The nav search: every entry the query matches at all, in nav order. An empty query keeps all. */
export function filterGalleryEntries(entries: GalleryEntry[], query: string): GalleryEntry[] {
    const normalized = normalizeGalleryQuery(query);

    if (!normalized) {
        return entries;
    }

    return entries.filter((entry) => galleryMatchScore(entry, normalized) > 0);
}

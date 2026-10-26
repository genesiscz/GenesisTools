import type { SiteCost } from "./types";

export interface SiteGroup {
    kind: SiteCost["kind"];
    key: string;
    external: boolean;
    sites: number;
    files: number;
    instantiations: number;
    types: number;
    ms: number;
    /** The median site: high with many sites means a code shape that costs at every use. */
    medianInstantiations: number;
    /** The costliest site; one large site and a low median means the first use of a library type. */
    max: Pick<SiteCost, "file" | "line" | "instantiations">;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    }

    return sorted[mid] ?? 0;
}

/** Site costs grouped by what each site calls or references. */
export function groupSites(sites: SiteCost[]): SiteGroup[] {
    const groups = new Map<string, SiteCost[]>();

    for (const site of sites) {
        const id = `${site.kind} ${site.key}`;
        const members = groups.get(id);

        if (members) {
            members.push(site);
        } else {
            groups.set(id, [site]);
        }
    }

    return [...groups.values()].map((members) => {
        const first = members[0] as SiteCost;
        const max = members.reduce((best, site) => (site.instantiations > best.instantiations ? site : best), first);
        return {
            kind: first.kind,
            key: first.key,
            external: first.external,
            sites: members.length,
            files: new Set(members.map((site) => site.file)).size,
            instantiations: members.reduce((sum, site) => sum + site.instantiations, 0),
            types: members.reduce((sum, site) => sum + site.types, 0),
            ms: Math.round(members.reduce((sum, site) => sum + site.ms, 0)),
            medianInstantiations: median(members.map((site) => site.instantiations)),
            max: { file: max.file, line: max.line, instantiations: max.instantiations },
        };
    });
}

/** The single sites whose key holds `needle`, costliest first; `projectOnly` drops package and lib keys. */
export function sitesForKey(sites: SiteCost[], needle: string, projectOnly: boolean): SiteCost[] {
    return sites
        .filter((site) => site.key.includes(needle) && (!projectOnly || !site.external))
        .sort((a, b) => b.instantiations - a.instantiations);
}

export const SITE_SORT_KEYS = ["instantiations", "median", "types", "ms", "sites"] as const;
export type SiteSortKey = (typeof SITE_SORT_KEYS)[number];

export function sortGroups(groups: SiteGroup[], by: SiteSortKey): SiteGroup[] {
    const value = (group: SiteGroup): number => (by === "median" ? group.medianInstantiations : group[by]);
    return [...groups].sort((a, b) => value(b) - value(a));
}

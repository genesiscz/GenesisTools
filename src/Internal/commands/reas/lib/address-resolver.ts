import { type SuggestResult, suggestLocality } from "@app/Internal/commands/reas/api/sreality-client";
import { type DistrictInfo, getDistrict, searchDistricts } from "@app/Internal/commands/reas/data/districts";
import { parsePeriod } from "@app/Internal/commands/reas/lib/config-builder";
import type { AnalysisFilters } from "@app/Internal/commands/reas/types";

export interface ResolvedAddress {
    /** The matched district from the database */
    district: DistrictInfo;
    /** Municipality name from the suggest API */
    municipalityName: string;
    /** Original suggest result for context */
    suggestResult: SuggestResult;
}

export interface BuildFiltersOptions {
    district: DistrictInfo;
    constructionType: string;
    disposition?: string;
    periods?: string[];
}

/**
 * Resolve a free-text address/locality query into matched districts.
 *
 * Flow:
 * 1. Call Sreality suggest API to get location suggestions
 * 2. Cross-reference each suggestion with the district database
 * 3. Return matched results with district info
 */
export async function resolveAddress(query: string): Promise<ResolvedAddress[]> {
    const suggestions = await suggestLocality(query);
    const results: ResolvedAddress[] = [];
    const seenDistricts = new Set<string>();

    for (const suggestion of suggestions) {
        const resolved = parseResolvedAddress(suggestion);

        if (!resolved) {
            continue;
        }

        // Deduplicate by district name
        if (seenDistricts.has(resolved.district.name)) {
            continue;
        }

        seenDistricts.add(resolved.district.name);
        results.push(resolved);
    }

    return results;
}

/**
 * Parse a single Sreality suggest result and cross-reference it
 * with the district database.
 *
 * Matching strategy:
 * 1. Try exact match on municipality name
 * 2. Try fuzzy search on municipality name (picks first result)
 * 3. Try exact match on the suggest value itself
 *
 * Returns null if no district match is found.
 */
export function parseResolvedAddress(suggestion: SuggestResult): ResolvedAddress | null {
    const municipality = suggestion.municipality;

    // Strategy 1: Try the suggest value first (e.g. "Praha 4" before "Praha")
    let district = getDistrict(suggestion.value);

    if (district) {
        return {
            district,
            municipalityName: municipality,
            suggestResult: suggestion,
        };
    }

    // Strategy 2: Exact match on municipality name
    district = getDistrict(municipality);

    if (district) {
        return {
            district,
            municipalityName: municipality,
            suggestResult: suggestion,
        };
    }

    // Strategy 3: Fuzzy search on municipality
    const fuzzyResults = searchDistricts(municipality);

    if (fuzzyResults.length > 0) {
        return {
            district: fuzzyResults[0],
            municipalityName: municipality,
            suggestResult: suggestion,
        };
    }

    return null;
}

/**
 * Build AnalysisFilters from a resolved district and user-provided options.
 */
export function buildSearchFilters(options: BuildFiltersOptions): AnalysisFilters {
    const disposition = options.disposition && options.disposition !== "all" ? options.disposition : undefined;

    const periods = parsePeriodStrings(options.periods);

    return {
        estateType: "flat",
        constructionType: options.constructionType,
        disposition,
        periods,
        district: {
            name: options.district.name,
            reasId: options.district.reasId,
            srealityId: options.district.srealityId,
            srealityLocality: options.district.srealityLocality,
        },
    };
}

function parsePeriodStrings(periods?: string[]) {
    if (!periods || periods.length === 0) {
        const currentYear = new Date().getFullYear();
        return [parsePeriod(String(currentYear))];
    }

    return periods.map(parsePeriod);
}

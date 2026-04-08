import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDashboardExport, type DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import {
    buildImportedPropertyDraft,
    type ImportedPropertyDraft,
} from "@app/Internal/commands/reas/lib/property-form-defaults";
import {
    type ListingRow,
    type PropertyAnalysisHistoryRow,
    type RentEstimate,
    reasDatabase,
    type SavedPropertyRow,
} from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

export interface PropertyDetail {
    property: SavedPropertyRow;
    history: PropertyAnalysisHistoryRow[];
    analysis: FullAnalysis | null;
    exportData: DashboardExport | null;
}

export interface PropertiesWithHistory {
    properties: SavedPropertyRow[];
    historyByProperty: Record<number, PropertyAnalysisHistoryRow[]>;
}

export interface PropertyImportDraft {
    draft: ImportedPropertyDraft;
    listing: ListingRow;
    rentEstimate: RentEstimate | null;
}

export function getPropertyDetail(id: number): PropertyDetail | null {
    const property = reasDatabase.getProperty(id);

    if (!property) {
        return null;
    }

    const history = reasDatabase.getPropertyAnalysisHistory(id);
    const analysis = property.last_analysis_json ? (SafeJSON.parse(property.last_analysis_json) as FullAnalysis) : null;

    return {
        property,
        history,
        analysis,
        exportData: analysis ? buildDashboardExport(analysis) : null,
    };
}

export function getAllPropertiesWithHistory(): PropertiesWithHistory {
    const properties = reasDatabase.getProperties();
    const historyByProperty = Object.fromEntries(
        properties.map((property) => [property.id, reasDatabase.getPropertyAnalysisHistory(property.id, 8)])
    );

    return { properties, historyByProperty };
}

export function getPropertyImportDraft(listingUrl: string): PropertyImportDraft | null {
    const listing = reasDatabase.getListingByUrl(listingUrl);

    if (!listing) {
        return null;
    }

    const rentEstimate = reasDatabase.estimateMonthlyRent({
        district: listing.district,
        disposition: listing.disposition ?? undefined,
        area: listing.area ?? undefined,
    });

    return {
        draft: buildImportedPropertyDraft({ listing, rentEstimate }),
        listing,
        rentEstimate,
    };
}

export async function refreshPropertyAnalysis(id: number): Promise<SavedPropertyRow | null> {
    const property = reasDatabase.getProperty(id);

    if (!property) {
        return null;
    }

    const district = resolveDistrict(property.district);
    const { filters, target } = buildConfig({
        district,
        constructionType: property.construction_type,
        disposition: property.disposition ?? undefined,
        periodsStr: property.periods ?? undefined,
        price: property.target_price,
        area: property.target_area,
        rent: property.monthly_rent,
        monthlyCosts: property.monthly_costs,
        providers: property.providers ?? undefined,
    });

    const analysis = await fetchAndAnalyze(filters, target, true);
    reasDatabase.updatePropertyAnalysis(id, analysis);

    return reasDatabase.getProperty(id);
}

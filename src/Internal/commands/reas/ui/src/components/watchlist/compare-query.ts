import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";

export function buildWatchlistCompareQuery(properties: SavedPropertyRow[]): URLSearchParams {
    const districts = [...new Set(properties.map((property) => property.district))];
    const firstProperty = properties[0];
    const averagePrice = Math.round(
        properties.reduce((sum, property) => sum + property.target_price, 0) / (properties.length || 1)
    );
    const averageArea = Math.round(
        properties.reduce((sum, property) => sum + property.target_area, 0) / (properties.length || 1)
    );

    const params = new URLSearchParams();

    if (districts.length > 0) {
        params.set("districts", districts.join(","));
    }

    if (firstProperty?.construction_type) {
        params.set("type", firstProperty.construction_type);
    }

    if (firstProperty?.disposition) {
        params.set("disposition", firstProperty.disposition);
    }

    if (averagePrice > 0) {
        params.set("price", String(averagePrice));
    }

    if (averageArea > 0) {
        params.set("area", String(averageArea));
    }

    return params;
}

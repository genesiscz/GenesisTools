import { buildConfig, resolveDistrict } from "./config-builder";

export const PRAHA_DISTRICT_NAMES = Array.from({ length: 22 }, (_, index) => `Praha ${index + 1}`);

export interface DistrictPreseedResult {
    total: number;
    succeeded: number;
    failed: number;
    warnings: string[];
}

export async function runDistrictPreseed({
    analyzeDistrict,
    districts = PRAHA_DISTRICT_NAMES,
}: {
    analyzeDistrict: (district: string) => Promise<void>;
    districts?: string[];
}): Promise<DistrictPreseedResult> {
    const warnings: string[] = [];
    let succeeded = 0;

    for (const district of districts) {
        try {
            await analyzeDistrict(district);
            succeeded++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`${district}: ${message}`);
        }
    }

    return {
        total: districts.length,
        succeeded,
        failed: districts.length - succeeded,
        warnings,
    };
}

export function buildDistrictPreseedConfig({
    district,
    constructionType,
    disposition,
    periods,
    price,
    area,
    rent,
    monthlyCosts,
    providers,
}: {
    district: string;
    constructionType: string;
    disposition?: string;
    periods?: string;
    price: number;
    area: number;
    rent?: number;
    monthlyCosts?: number;
    providers?: string;
}) {
    const resolvedDistrict = resolveDistrict(district);

    return buildConfig({
        district: resolvedDistrict,
        constructionType,
        disposition,
        periodsStr: periods,
        price,
        area,
        rent,
        monthlyCosts,
        providers,
    });
}

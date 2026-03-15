export interface ReasListing {
    _id: string;
    formattedAddress: string;
    formattedLocation: string;
    soldPrice: number;
    price: number;
    originalPrice: number;
    disposition: string;
    utilityArea: number;
    displayArea: number;
    soldAt: string;
    firstVisibleAt: string;
    point: { type: string; coordinates: [number, number] };
    cadastralAreaSlug: string;
    municipalitySlug: string;
    link: string;
}

export interface SrealityRental {
    hash_id: number;
    name: string;
    price: number;
    locality: string;
    gps: { lat: number; lon: number };
    labels: string[];
    disposition?: string;
    area?: number;
    link?: string;
}

export interface MfRentalBenchmark {
    cadastralUnit: string;
    municipality: string;
    sizeCategory: "VK1" | "VK2" | "VK3" | "VK4";
    referencePrice: number;
    confidenceMin: number;
    confidenceMax: number;
    median: number;
    newBuildPrice: number;
    coverageScore: number;
}

export interface TargetProperty {
    price: number;
    area: number;
    disposition: string;
    constructionType: string;
    monthlyRent: number;
    monthlyCosts: number;
    district: string;
    districtId: number;
    srealityDistrictId: number;
}

export interface AnalysisFilters {
    estateType: string;
    constructionType: string;
    disposition?: string;
    periods: DateRange[];
    district: { name: string; reasId: number; srealityId: number };
}

export interface DateRange {
    label: string;
    from: Date;
    to: Date;
}

export interface CacheEntry<T> {
    fetchedAt: string;
    params: Record<string, unknown>;
    count: number;
    data: T[];
}

export interface AnalysisResult {
    soldComparables: ReasListing[];
    rentalListings: SrealityRental[];
    mfBenchmarks: MfRentalBenchmark[];
    target: TargetProperty;
    filters: AnalysisFilters;
}

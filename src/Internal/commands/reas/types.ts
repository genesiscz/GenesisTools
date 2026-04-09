export interface ReasListing {
    _id: string;
    formattedAddress: string;
    formattedLocation: string;
    soldPrice: number;
    price: number;
    originalPrice: number;
    pricePerM2?: number;
    disposition: string;
    utilityArea: number;
    displayArea: number;
    soldAt: string;
    firstVisibleAt: string;
    daysOnMarket?: number;
    discount?: number;
    point: { type: string; coordinates: [number, number] };
    cadastralAreaSlug: string;
    municipalitySlug: string;
    link: string;
}

export interface SrealityRental {
    id: string;
    source: "sreality";
    sourceId: string;
    sourceContract: string;
    type: "rental";
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

export interface UnifiedListing {
    id: string;
    source: ProviderName;
    sourceId: string;
    sourceContract: string;
    type: "sale" | "rental" | "sold";
    price: number;
    pricePerM2?: number;
    address: string;
    disposition?: string;
    area?: number;
    link: string;
    coordinates?: ListingCoordinates;
    buildingType?: string;
    description?: string;
    images?: string[];
    originalPrice?: number;
    isDiscounted?: boolean;
    uri?: string;
    links?: ProviderLink[];
    fetchedAt?: string;
    soldAt?: string;
    daysOnMarket?: number;
    discount?: number;
    rawData?: unknown;
}

export interface ProviderLink {
    url: string;
    type?: string;
    status?: string;
}

export interface ListingCoordinates {
    lat: number;
    lng: number;
}

export interface RentalListing {
    id: string;
    source: Exclude<ProviderName, "reas" | "mf">;
    sourceId: string;
    sourceContract: string;
    type: "rental";
    hash_id?: number;
    name?: string;
    price: number;
    locality: string;
    disposition?: string;
    area?: number;
    link?: string;
    charges?: number;
    gps?: { lat: number; lon: number };
    coordinates?: ListingCoordinates;
    description?: string;
    labels: string[];
    uri?: string;
    originalPrice?: number;
    isDiscounted?: boolean;
    availableFrom?: number | string | null;
    imageAltText?: string;
    links?: ProviderLink[];
    rawData?: unknown;
}

export interface SaleListing {
    id: string;
    source: Exclude<ProviderName, "mf">;
    sourceId: string;
    sourceContract: string;
    type: "sale" | "sold";
    price: number;
    address: string;
    disposition?: string;
    area?: number;
    pricePerM2?: number;
    link: string;
    coordinates?: ListingCoordinates;
    soldAt?: string;
    daysOnMarket?: number;
    discount?: number;
    originalPrice?: number;
    isDiscounted?: boolean;
    imageAltText?: string;
    description?: string;
    uri?: string;
    links?: ProviderLink[];
    rawData?: unknown;
}

export interface ProviderFetchSummary {
    provider: ProviderName;
    sourceContract: string;
    count: number;
    fetchedAt: string;
    error?: string;
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

export type ProviderName = "reas" | "sreality" | "ereality" | "bezrealitky" | "mf";

export interface AnalysisFilters {
    estateType: string;
    constructionType: string;
    disposition?: string;
    periods: DateRange[];
    district: {
        name: string;
        reasId: number;
        srealityId: number;
        srealityLocality: "district" | "region";
    };
    priceMin?: number;
    priceMax?: number;
    areaMin?: number;
    areaMax?: number;
    providers?: ProviderName[];
    heatingKind?: string[];
    bounds?: import("@app/Internal/commands/reas/api/ReasClient.types").ReasBounds;
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
    rentalListings: RentalListing[];
    mfBenchmarks: MfRentalBenchmark[];
    target: TargetProperty;
    filters: AnalysisFilters;
}

export interface FullAnalysis {
    comparables: import("@app/Internal/commands/reas/analysis/comparables").ComparablesResult;
    activeVsSold?: import("@app/Internal/commands/reas/analysis/active-vs-sold").ActiveVsSoldComparison;
    trends: import("@app/Internal/commands/reas/analysis/trends").TrendsResult;
    yield: import("@app/Internal/commands/reas/analysis/rental-yield").YieldResult;
    timeOnMarket: import("@app/Internal/commands/reas/analysis/time-on-market").TimeOnMarketResult;
    discount: import("@app/Internal/commands/reas/analysis/discount").DiscountResult;
    rentalListings: RentalListing[];
    saleListings?: SaleListing[];
    bezrealitkyListings?: {
        rentals: RentalListing[];
        sales: SaleListing[];
    };
    mfBenchmarks: MfRentalBenchmark[];
    target: TargetProperty;
    filters: AnalysisFilters;
    investmentScore?: import("@app/Internal/commands/reas/analysis/investment-score").InvestmentScore;
    momentum?: import("@app/Internal/commands/reas/analysis/market-momentum").MarketMomentum;
    rentalAggregation?: import("@app/Internal/commands/reas/analysis/rental-aggregation").AggregatedRentalStats[];
    providerSummary?: ProviderFetchSummary[];
}

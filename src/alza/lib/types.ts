export interface ProductSummary {
    id: number;
    code: string;
    name: string;
    url: string;
    spec?: string;
    image?: string;
    price?: number;
    /** The struck-through price Alza shows next to a discounted price. */
    originalPrice?: number;
    discountPercent?: number;
    /** The price box header, e.g. "BLACK FRIDAY -19 %". */
    badge?: string;
    availability?: string;
    inStock?: boolean;
    rating?: number;
    ratingCount?: number;
    currency: string;
}

export interface ProductParam {
    group: string;
    name: string;
    values: string[];
}

export interface ProductDetail extends ProductSummary {
    ean?: string;
    brandId?: number;
    warranty?: string;
    category?: { id: number; name: string };
    deliveryNote?: string;
    /** Alza's legal note on the lowest price of the 30 days before the discount. */
    priceNote?: string;
    questionCount?: number;
    sold?: number;
    images: string[];
    params: ProductParam[];
}

export interface Review {
    author?: string;
    date?: string;
    rating: number;
    text?: string;
    pros: string[];
    cons: string[];
    verified: boolean;
    likes: number;
    variant?: string;
    /** Storefront country of the review (Alza mixes in Slovak reviews). */
    country?: string;
    translated: boolean;
    imageCount: number;
}

export interface ReviewsResult {
    productId: number;
    total: number;
    average?: number;
    /** Review count per star, index 0 = one star. */
    distribution: [number, number, number, number, number];
    reviews: Review[];
}

export interface Question {
    id: number;
    author?: string;
    text: string;
    created?: string;
    upVotes: number;
    downVotes: number;
    answerCount: number;
    answers: Question[];
}

export interface QuestionsResult {
    productId: number;
    total: number;
    questions: Question[];
}

export interface FacetValue {
    id: number;
    name: string;
    count?: number;
}

export interface Facet {
    group: string;
    paramId: number;
    name: string;
    kind?: string;
    values: FacetValue[];
}

export interface CategoryFilters {
    categoryId: number;
    brands: FacetValue[];
    facets: Facet[];
    priceSteps: number[];
}

export interface CategoryInfo {
    id: number;
    name?: string;
    url: string;
    breadcrumbs: string[];
    children: Array<{ id?: number; name: string; url?: string }>;
}

export interface ListingPage {
    total?: number;
    /** The last page read. */
    page: number;
    hasMore: boolean;
    /**
     * Where the next call continues: pass `page` and `skip` back. `skip` counts the matching products of that page
     * already returned (non-zero when the limit cut the page). Absent when the listing ended.
     */
    next?: { page: number; skip: number };
    items: ProductSummary[];
}

export interface Suggestions {
    phrases: string[];
    products: Array<{ name: string; id?: number; url?: string }>;
    categories: Array<{ name: string; id?: number; url?: string }>;
    brands: Array<{ name: string; url?: string }>;
}

export interface PickupPlace {
    id: string;
    kind: string;
    name: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    distanceKm?: number;
}

import type { ReasListing } from "@app/Internal/commands/reas/types";

export interface CountResponse {
    success: boolean;
    data: { count: number };
}

export interface ListingsResponse {
    success: boolean;
    data: ReasListing[];
    page: number;
    limit: number;
    nextPage: number | null;
}

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

export interface ReasBounds {
    southWestLatitude: number;
    southWestLongitude: number;
    northEastLatitude: number;
    northEastLongitude: number;
}

export interface ReasPointer {
    _id: string;
    point: { type: "Point"; coordinates: [number, number] };
    geohash: string;
    estatesCount: number;
}

export interface ReasClusterPointer {
    geohash: string;
    point: { type: "Point"; coordinates: [number, number] };
    actualPoint: { type: "Point"; coordinates: [number, number] };
    clusterBounds: [[number, number], [number, number]];
    amount: number;
}

export interface PointersAndClustersResponse {
    success: boolean;
    data: {
        pointers: ReasPointer[];
        clusterPointers: ReasClusterPointer[];
    };
}

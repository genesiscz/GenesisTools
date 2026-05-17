import { KosikClient } from "@app/shops/api/shops/KosikClient";

export interface KosikProfile {
    client: { id: number; name: string; surname: string; email: string };
    ordersCount: number;
    creditsTotalAmount?: number;
}

export interface KosikOrderListEntry {
    id: number;
    orderedAt?: string;
    total?: number;
    state?: string;
    [k: string]: unknown;
}

export interface KosikOrderListResponse {
    orders: KosikOrderListEntry[];
    totalNumberOfOrders: number;
}

export interface KosikOrderItemRaw {
    id?: number | string;
    productId?: number | string;
    slug?: string;
    name?: string;
    quantity?: number;
    unit?: string;
    unitPrice?: number;
    totalPrice?: number;
    [k: string]: unknown;
}

export interface KosikOrderDetail {
    id?: number | string;
    items?: KosikOrderItemRaw[];
    [k: string]: unknown;
}

export interface KosikAuthClientConfig {
    sessionCookie: string;
}

export class KosikAuthClient extends KosikClient {
    private readonly sessionCookie: string;

    constructor(config: KosikAuthClientConfig) {
        super({ rateLimitPerSecond: 4 });
        if (!config.sessionCookie) {
            throw new Error("KosikAuthClient requires a sessionCookie");
        }

        this.sessionCookie = config.sessionCookie;
        this.setHeader("Cookie", this.sessionCookie);
    }

    async getProfile(): Promise<KosikProfile> {
        const res = await this.requestRaw<KosikProfile>("GET", "/api/front/profile");
        return res.data;
    }

    async listOrders(opts: { limit: number; offset: number; showArchived?: boolean }): Promise<KosikOrderListResponse> {
        const showArchived = opts.showArchived ?? true;
        const res = await this.requestRaw<KosikOrderListResponse>(
            "GET",
            `/api/front/profile/order-list?limit=${opts.limit}&showArchived=${showArchived}&offset=${opts.offset}`
        );
        return res.data;
    }

    async getOrderDetail(id: number | string): Promise<KosikOrderDetail> {
        const res = await this.requestRaw<KosikOrderDetail>("GET", `/api/front/profile/order/${id}`);
        return res.data;
    }
}

import { RohlikClient } from "@app/shops/api/shops/RohlikClient";
import { SafeJSON } from "@app/utils/json";

export interface RohlikOrderListEntry {
    id: number;
    itemsCount: number;
    orderTime: string;
    priceComposition: { total: { amount: number; currency: string } };
    deliverySlot?: unknown | null;
}

export interface RohlikOrderItem {
    id: number;
    name: string;
    unit: string | null;
    textualAmount: string | null;
    amount: number;
    images?: string[];
    priceComposition: {
        total: { amount: number; currency: string };
        unit?: { amount: number; currency: string };
    };
    orderFieldId?: number;
    compensated?: boolean;
}

export interface RohlikOrderDetail {
    id: number;
    items: RohlikOrderItem[];
    priceComposition?: { total: { amount: number; currency: string } };
    orderTime?: string;
    state?: string;
}

export interface RohlikProfile {
    id?: number;
    email: string;
    name?: string;
    surname?: string;
}

export interface RohlikAuthClientConfig {
    sessionCookie?: string;
}

export class RohlikAuthClient extends RohlikClient {
    private sessionCookie: string | null;

    constructor(config: RohlikAuthClientConfig = {}) {
        super({ rateLimitPerSecond: 4 });
        this.sessionCookie = config.sessionCookie ?? null;
        if (this.sessionCookie) {
            this.setHeader("Cookie", this.sessionCookie);
        }
    }

    getSessionCookie(): string | null {
        return this.sessionCookie;
    }

    async login(email: string, password: string): Promise<void> {
        const res = await fetch("https://www.rohlik.cz/services/frontend-service/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ email, password }),
        });
        if (res.status !== 200) {
            const text = await res.text();
            throw new Error(`rohlik login failed: status=${res.status} body=${text.slice(0, 200)}`);
        }

        const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
        const flat = setCookie
            .filter(Boolean)
            .map((c) => c.split(";")[0].trim())
            .join("; ");
        if (!flat) {
            throw new Error("rohlik login returned 200 without Set-Cookie");
        }

        this.sessionCookie = flat;
        this.setHeader("Cookie", flat);
    }

    async logout(): Promise<void> {
        if (!this.sessionCookie) {
            return;
        }

        await fetch("https://www.rohlik.cz/services/frontend-service/logout", {
            method: "POST",
            headers: { Cookie: this.sessionCookie },
        });
        this.sessionCookie = null;
        this.setHeader("Cookie", undefined);
    }

    async getProfile(): Promise<RohlikProfile> {
        const res = await this.requestRaw<RohlikProfile>("GET", "/services/frontend-service/v2/user-profile");
        return res.data;
    }

    async listOrders(opts: { limit: number; offset: number }): Promise<RohlikOrderListEntry[]> {
        const res = await this.requestRaw<RohlikOrderListEntry[]>(
            "GET",
            `/api/v3/orders/delivered?offset=${opts.offset}&limit=${opts.limit}`
        );
        return res.data;
    }

    async getOrderDetail(id: number): Promise<RohlikOrderDetail> {
        const res = await this.requestRaw<RohlikOrderDetail>("GET", `/api/v3/orders/${id}`);
        return res.data;
    }
}

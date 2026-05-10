import type { ShopApiClient } from "@app/shops/api/ShopApiClient";
import type { ShopOrigin } from "@app/shops/api/ShopApiClient.types";
// @ts-expect-error -- @hlidac-shopu/lib ships ESM with no .d.ts coverage
import { shopOrigin as deriveShopOrigin } from "@hlidac-shopu/lib/shops.mjs";

export class ShopRegistry {
    private static instance: ShopRegistry | null = null;
    private readonly clients = new Map<ShopOrigin, ShopApiClient>();

    private constructor() {
        // Plan 01 leaves the registry empty by design.
    }

    static get(): ShopRegistry {
        if (!ShopRegistry.instance) {
            ShopRegistry.instance = new ShopRegistry();
        }

        return ShopRegistry.instance;
    }

    static fresh(): ShopRegistry {
        return new ShopRegistry();
    }

    /** Test-only: clear the singleton so the next `get()` returns a fresh instance. */
    static reset(): void {
        ShopRegistry.instance = null;
    }

    register(client: ShopApiClient): void {
        this.clients.set(client.shopOrigin, client);
    }

    forShop(origin: ShopOrigin): ShopApiClient | undefined {
        return this.clients.get(origin);
    }

    forUrl(url: string): ShopApiClient | undefined {
        try {
            const origin = deriveShopOrigin(url) as string | null;
            return origin ? this.clients.get(origin) : undefined;
        } catch {
            return undefined;
        }
    }

    all(): ShopApiClient[] {
        return Array.from(this.clients.values());
    }
}

import { ShopRegistry } from "./ShopRegistry";
import { KauflandClient } from "./shops/KauflandClient";
import { KosikClient } from "./shops/KosikClient";
import { RohlikClient } from "./shops/RohlikClient";

let initialized = false;

export function initShopRegistry(): void {
    if (initialized) {
        return;
    }

    const registry = ShopRegistry.get();
    registry.register(new RohlikClient());
    registry.register(new KosikClient());
    registry.register(new KauflandClient());
    initialized = true;
}

/** Test-only — re-runs initialization after a registry reset. */
export function __resetInitState(): void {
    initialized = false;
}

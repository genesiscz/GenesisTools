import type { HttpRequestSink } from "../lib/http-sink";
import { ShopRegistry } from "./ShopRegistry";
import { KauflandClient } from "./shops/KauflandClient";
import { KosikClient } from "./shops/KosikClient";
import { RohlikClient } from "./shops/RohlikClient";

let initialized = false;

export function initShopRegistry(opts: { sink?: HttpRequestSink } = {}): void {
    if (initialized) {
        return;
    }

    const registry = ShopRegistry.get();
    registry.register(new RohlikClient({ sink: opts.sink }));
    registry.register(new KosikClient({ sink: opts.sink }));
    registry.register(new KauflandClient({ sink: opts.sink }));
    initialized = true;
}

/** Test-only — re-runs initialization after a registry reset. */
export function __resetInitState(): void {
    initialized = false;
}

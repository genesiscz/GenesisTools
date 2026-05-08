import type { HttpRequestSink } from "../lib/http-sink";
import { ShopRegistry } from "./ShopRegistry";
import { AlzaClient } from "./shops/AlzaClient";
import { BenuClient } from "./shops/BenuClient";
import { DrmaxClient } from "./shops/DrmaxClient";
import { ItescoClient } from "./shops/ItescoClient";
import { KauflandClient } from "./shops/KauflandClient";
import { KnihyDobrovskyClient } from "./shops/KnihyDobrovskyClient";
import { KosikClient } from "./shops/KosikClient";
import { MallClient } from "./shops/MallClient";
import { MountfieldClient } from "./shops/MountfieldClient";
import { NotinoClient } from "./shops/NotinoClient";
import { PilulkaClient } from "./shops/PilulkaClient";
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
    registry.register(new AlzaClient({ sink: opts.sink }));
    registry.register(new DrmaxClient({ sink: opts.sink }));
    registry.register(new NotinoClient({ sink: opts.sink }));
    registry.register(new BenuClient({ sink: opts.sink }));
    registry.register(new MallClient({ sink: opts.sink }));
    registry.register(new MountfieldClient({ sink: opts.sink }));
    registry.register(new ItescoClient({ sink: opts.sink }));
    registry.register(new PilulkaClient({ sink: opts.sink }));
    registry.register(new KnihyDobrovskyClient({ sink: opts.sink }));
    initialized = true;
}

/** Test-only — re-runs initialization after a registry reset. */
export function __resetInitState(): void {
    initialized = false;
}

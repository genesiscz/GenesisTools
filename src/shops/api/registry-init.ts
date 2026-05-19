import { logger } from "@app/logger";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { AlbertClient } from "@app/shops/api/shops/AlbertClient";
import { AlzaClient } from "@app/shops/api/shops/AlzaClient";
import { BenuClient } from "@app/shops/api/shops/BenuClient";
import { BillaClient } from "@app/shops/api/shops/BillaClient";
import { DmClient } from "@app/shops/api/shops/DmClient";
import { DrmaxClient } from "@app/shops/api/shops/DrmaxClient";
import { HornbachClient } from "@app/shops/api/shops/HornbachClient";
import { ItescoClient } from "@app/shops/api/shops/ItescoClient";
import { KauflandClient } from "@app/shops/api/shops/KauflandClient";
import { KnihyDobrovskyClient } from "@app/shops/api/shops/KnihyDobrovskyClient";
import { KosikClient } from "@app/shops/api/shops/KosikClient";
import { LidlClient } from "@app/shops/api/shops/LidlClient";
import { MallClient } from "@app/shops/api/shops/MallClient";
import { MojaDmClient } from "@app/shops/api/shops/MojaDmClient";
import { MountfieldClient } from "@app/shops/api/shops/MountfieldClient";
import { NotinoClient } from "@app/shops/api/shops/NotinoClient";
import { PilulkaClient } from "@app/shops/api/shops/PilulkaClient";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";
import { TetaClient } from "@app/shops/api/shops/TetaClient";
import type { HttpRequestSink } from "@app/shops/lib/http-sink";
import { syncShopsFromRegistry } from "@app/shops/lib/sync-shops-from-registry";

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
    registry.register(new HornbachClient({ sink: opts.sink }));
    registry.register(new DmClient({ sink: opts.sink }));
    registry.register(new BillaClient({ sink: opts.sink }));
    registry.register(new LidlClient({ sink: opts.sink }));
    registry.register(new TetaClient({ sink: opts.sink }));
    registry.register(new AlbertClient({ sink: opts.sink }));
    registry.register(new MojaDmClient({ sink: opts.sink }));
    initialized = true;

    // Sync the shops table from registered clients so /coverage capability
    // badges and bot_protection labels match the source of truth (the
    // ShopApiClient.capabilities). Fire-and-forget — keeps initShopRegistry
    // synchronous (it's called from many CLI commands) and any DB write
    // failure shouldn't block the registry.
    void syncShopsFromRegistry().catch((err) =>
        logger.warn({ err, component: "registry-init" }, "syncShopsFromRegistry failed")
    );
}

/** Test-only — re-runs initialization after a registry reset. */
export function __resetInitState(): void {
    initialized = false;
}

// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js (SK branch)

import type { ShopApiClientConstructorConfig } from "../ShopApiClient";
import { DmClient } from "./DmClient";

export class MojaDmClient extends DmClient {
    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({ ...config, country: "SK" });
    }
}

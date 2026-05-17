// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js (SK branch)

import { DmClient, type DmClientConfig } from "@app/shops/api/shops/DmClient";

export class MojaDmClient extends DmClient {
    constructor(config: DmClientConfig = {}) {
        super({ ...config, country: "SK" });
    }
}

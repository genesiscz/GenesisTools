// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js (SK branch)

import { type DmClientConfig, DmClient } from "./DmClient";

export class MojaDmClient extends DmClient {
    constructor(config: DmClientConfig = {}) {
        super({ ...config, country: "SK" });
    }
}

import { describe, expect, it } from "bun:test";
import { genesisAppRefreshAction } from "./genesis-app-refresh";

describe("genesisAppRefreshAction", () => {
    it("skips a user who never installed GenesisTools.app", () => {
        expect(genesisAppRefreshAction({ built: false, stale: false })).toBe("skip");
    });

    it("rebuilds an installed app whose sources changed", () => {
        expect(genesisAppRefreshAction({ built: true, stale: true })).toBe("rebuild");
    });

    it("leaves a current, installed app alone", () => {
        expect(genesisAppRefreshAction({ built: true, stale: false })).toBe("skip");
    });
});

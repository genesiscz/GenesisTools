import { describe, expect, it } from "bun:test";
import { buildServiceConfig } from "@app/dev-dashboard/server/transport/mdns-advertiser";

describe("buildServiceConfig", () => {
    it("advertises the devdashboard tcp service on the given port with a path TXT record", () => {
        const config = buildServiceConfig({ instanceName: "Martin's Mac", port: 3042 });

        expect(config).toEqual({
            name: "Martin's Mac",
            type: "devdashboard",
            port: 3042,
            protocol: "tcp",
            txt: { path: "/" },
        });
    });

    it("merges extra TXT records (e.g. a version tag) on top of the path default", () => {
        const config = buildServiceConfig({ instanceName: "Mac", port: 3042, txt: { v: "1" } });

        expect(config.txt).toEqual({ path: "/", v: "1" });
    });

    it("honors a custom service type", () => {
        const config = buildServiceConfig({ instanceName: "Mac", port: 9000, serviceType: "ddtest" });

        expect(config.type).toBe("ddtest");
    });
});

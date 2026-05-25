import { describe, expect, it } from "bun:test";
import { defaultLanDashboardUrl, resolveDashboardAccessPresentation } from "./access";
import type { DashboardAppConfig } from "./types";

describe("DashboardApp access", () => {
    it("defaultLanDashboardUrl includes port", () => {
        const url = defaultLanDashboardUrl(7243);
        expect(url).toContain(":7243/");
    });

    it("resolveDashboardAccessPresentation uses config access fields", () => {
        const config = {
            type: "server",
            key: "test",
            description: "test",
            commandName: "serve",
            port: 9000,
            spawn: { cmd: ["true"] },
            access: {
                qr: { small: true },
                label: "viewer",
                url: (port: number) => `http://lan.test:${port}/`,
            },
        } satisfies DashboardAppConfig;

        const presentation = resolveDashboardAccessPresentation(config, 9000);
        expect(presentation.url).toBe("http://lan.test:9000/");
        expect(presentation.label).toBe("viewer");
        expect(presentation.qr).toEqual({ small: true });
    });

    it("resolveDashboardAccessPresentation allows url override", () => {
        const config = {
            type: "server",
            key: "test",
            description: "test",
            commandName: "serve",
            port: 9000,
            spawn: { cmd: ["true"] },
        } satisfies DashboardAppConfig;

        const presentation = resolveDashboardAccessPresentation(config, 9000, {
            url: "http://lan.test:9000/?source=task&session=metro",
        });
        expect(presentation.url).toContain("session=metro");
    });
});

import { describe, expect, it } from "bun:test";
import {
    defaultLanDashboardUrl,
    defaultLocalDashboardUrl,
    resolveDashboardAccessPresentation,
    resolveDashboardBindHost,
    resolveDashboardBrowserUrl,
} from "./access";
import { writePreferences } from "./preferences";
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

    it("resolveDashboardBrowserUrl uses localhost for default bind", () => {
        const config = {
            type: "ui",
            key: "test",
            description: "test",
            commandName: "ui",
            spawn: { cmd: ["true"] },
        } satisfies DashboardAppConfig;

        expect(resolveDashboardBrowserUrl(config, 3000)).toBe(defaultLocalDashboardUrl(3000));
    });

    it("resolveDashboardBrowserUrl uses LAN for 0.0.0.0 bind", () => {
        const config = {
            type: "ui",
            key: "test",
            description: "test",
            commandName: "ui",
            bindHost: "0.0.0.0",
            spawn: { cmd: ["true"] },
        } satisfies DashboardAppConfig;

        expect(resolveDashboardBrowserUrl(config, 7243)).toBe(defaultLanDashboardUrl(7243));
    });

    it("resolveDashboardBindHost defaults to loopback and lets the preferences file override the registry", () => {
        const base = {
            type: "server",
            description: "test",
            commandName: "serve",
            port: 4242,
            spawn: { cmd: ["true"] },
        } as const;

        expect(resolveDashboardBindHost({ ...base, key: "bind-default" })).toBe("127.0.0.1");
        expect(resolveDashboardBindHost({ ...base, key: "bind-registry", bindHost: "0.0.0.0" })).toBe("0.0.0.0");

        writePreferences("bind-widened", { bindHost: "0.0.0.0" });
        expect(resolveDashboardBindHost({ ...base, key: "bind-widened" })).toBe("0.0.0.0");

        writePreferences("bind-pinned", { bindHost: "127.0.0.1" });
        expect(resolveDashboardBindHost({ ...base, key: "bind-pinned", bindHost: "0.0.0.0" })).toBe("127.0.0.1");
    });
});

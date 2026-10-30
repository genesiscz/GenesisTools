import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { DASHBOARDS, WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";
import { applyPresets, presetDrift, presets } from "./presets";
import { defaultRouterConfig, parseConfig, type RouteAction, type RouterConfig, route } from "./route";
import { registryServices } from "./services";

const FLAG = "allowExecuteByPlainBrowserNavigationMightBeDangerous";

/** The six servers a page must never start by itself: accounts, OAuth, webhooks, local APIs. */
const CLOSED_WEB_SERVICES = {
    "ai-proxy": 8317,
    "mcp-gateway": 8318,
    "telegram-webhook": 8319,
    "youtube-server": 9886,
    "youtube-extension": 9877,
    "monitor-server": 9878,
};

/** An invented router config with both service presets synced, as `tools browser-router presets sync` writes it. */
function syncedConfig(): RouterConfig {
    const config: RouterConfig = {
        ...defaultRouterConfig(),
        linkHost: "links.example.test",
        presets: { "local-services": {}, "dashboard-names": {} },
    };
    return { ...config, routes: applyPresets(config.routes, presets({ config, check: () => true })) };
}

function serviceActions(config: RouterConfig, port: number): Extract<RouteAction, { type: "service" }>[] {
    return config.routes.flatMap((rule) =>
        rule.action.type === "service" && rule.action.port === port ? [rule.action] : []
    );
}

describe("allowExecuteByPlainBrowserNavigationMightBeDangerous on the registry services", () => {
    test("is true on every dashboard and false on every web service the registry leaves it off", () => {
        const byKey = new Map(registryServices().map((service) => [service.key, service]));

        for (const [key, port] of Object.entries(CLOSED_WEB_SERVICES)) {
            expect({ key, port: byKey.get(key)?.port, allowed: byKey.get(key)?.[FLAG] }).toEqual({
                key,
                port,
                allowed: false,
            });
        }

        for (const key of Object.keys(DASHBOARDS)) {
            expect({ key, allowed: byKey.get(key)?.[FLAG] }).toEqual({ key, allowed: true });
        }
    });

    test("comes only from the entry's literal true, never from being a dashboard or having a launch command", () => {
        const dashboard = {
            key: "zz-new-dashboard",
            name: "New Dashboard",
            description: "An invented dashboard with a launch command and no flag.",
            port: 65_001,
            launch: "tools zz-new-dashboard serve",
            portOverride: null,
            matchProcess: () => false,
        };
        const webService = { ...dashboard, key: "zz-new-service", name: "New Service", port: 65_002 };
        const spelled = { ...dashboard, key: "zz-spelled", name: "Spelled", port: 65_003, [FLAG]: "true" };
        expect(Reflect.set(DASHBOARDS, dashboard.key, dashboard)).toBe(true);
        expect(Reflect.set(DASHBOARDS, spelled.key, spelled)).toBe(true);
        expect(Reflect.set(WEB_SERVICES, webService.key, webService)).toBe(true);

        try {
            const found = registryServices().filter((service) => service.key.startsWith("zz-"));
            expect(found.map((service) => [service.key, service.dashboard, service[FLAG]])).toEqual([
                ["zz-new-dashboard", true, false],
                ["zz-spelled", true, false],
                ["zz-new-service", false, false],
            ]);
        } finally {
            Reflect.deleteProperty(DASHBOARDS, dashboard.key);
            Reflect.deleteProperty(DASHBOARDS, spelled.key);
            Reflect.deleteProperty(WEB_SERVICES, webService.key);
        }
    });

    test("preset sync puts the flag on every service action, for the loopback and the name spelling", () => {
        const config = syncedConfig();
        const library = serviceActions(config, DASHBOARDS["artifact-library"].port);
        const proxy = serviceActions(config, CLOSED_WEB_SERVICES["ai-proxy"]);

        // local-services, the name host, and the name as a path on the link host.
        expect(library.length).toBe(3);
        expect(library.map((action) => action[FLAG])).toEqual([true, true, true]);
        expect(proxy.length).toBe(1);
        expect(proxy.map((action) => action[FLAG] === true)).toEqual([false]);

        // The saved file keeps the literal true through a reload.
        const reread = parseConfig(SafeJSON.parse(SafeJSON.stringify(config), { strict: true }));
        expect(serviceActions(reread, DASHBOARDS["artifact-library"].port).map((action) => action[FLAG])).toEqual([
            true,
            true,
            true,
        ]);
        expect(serviceActions(reread, CLOSED_WEB_SERVICES["ai-proxy"]).map((action) => action[FLAG] === true)).toEqual([
            false,
        ]);

        // A service without the flag has no key at all, so the saved action equals the preset's and nothing drifts.
        for (const action of serviceActions(reread, CLOSED_WEB_SERVICES["ai-proxy"])) {
            expect(FLAG in action).toBe(false);
        }

        for (const preset of presets({ config: reread, check: () => true })) {
            if (preset.id === "local-services" || preset.id === "dashboard-names") {
                expect(presetDrift(reread, preset)).toEqual([]);
            }
        }
    });

    test("an external click still starts a server whose flag is false", () => {
        for (const [key, port] of Object.entries(CLOSED_WEB_SERVICES)) {
            expect({ key, decision: route(`http://127.0.0.1:${port}/`, syncedConfig()) }).toMatchObject({
                key,
                decision: {
                    kind: "run",
                    argv: ["tools", "browser-router", "ensure", String(port)],
                    needsApproval: false,
                    url: `http://localhost:${port}/`,
                    service: { port },
                },
            });
        }
    });
});

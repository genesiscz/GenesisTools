import { describe, expect, it } from "bun:test";
import { dashboardUrlWithQuery } from "./lifecycle";
import type { DashboardAppConfig } from "./types";

const baseConfig = {
    type: "server",
    key: "test",
    description: "test",
    commandName: "serve",
    spawn: { cmd: ["true"] },
} satisfies DashboardAppConfig;

describe("DashboardApp open", () => {
    it("dashboardUrlWithQuery appends query params", () => {
        const url = dashboardUrlWithQuery(
            { ...baseConfig, bindHost: "0.0.0.0" },
            7243,
            { source: "task", session: "metro" },
            "http://192.168.0.15:7243/"
        );
        expect(url).toContain("source=task");
        expect(url).toContain("session=metro");
    });

    it("dashboardUrlWithQuery defaults to localhost for loopback dashboards", () => {
        const url = dashboardUrlWithQuery(baseConfig, 3000);
        expect(url).toBe("http://127.0.0.1:3000/");
    });
});

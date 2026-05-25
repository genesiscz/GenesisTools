import { describe, expect, it } from "bun:test";
import { dashboardUrlWithQuery } from "./lifecycle";

describe("DashboardApp open", () => {
    it("dashboardUrlWithQuery appends query params", () => {
        const url = dashboardUrlWithQuery(7243, { source: "task", session: "metro" }, "http://192.168.0.15:7243/");
        expect(url).toContain("source=task");
        expect(url).toContain("session=metro");
    });
});

import { describe, expect, it } from "bun:test";
import { systemRoutes } from "@app/dev-dashboard/server/routes/system";

describe("systemRoutes", () => {
    it("registers pulse + history with the right methods/patterns", () => {
        const defs = systemRoutes();
        const paths = defs.map((d) => `${d.method} ${d.pattern}`);
        expect(paths).toContain("GET /api/system/pulse");
        expect(paths).toContain("GET /api/system/pulse/history");
    });
});

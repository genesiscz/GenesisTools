import { describe, expect, it } from "bun:test";
import { timelineRoutes } from "@app/dev-dashboard/server/routes/timeline";

describe("timelineRoutes", () => {
    it("registers GET /api/timeline", () => {
        const defs = timelineRoutes();
        const sigs = defs.map((d) => `${d.method} ${d.pattern}`);
        expect(sigs).toContain("GET /api/timeline");
    });
});

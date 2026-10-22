import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { affectedDashboards, SMOKE_DASHBOARDS } from "./dashboard-smoke";

describe("dashboard-smoke", () => {
    test("shared code and package files reach every dashboard; a dashboard's own folder reaches only it", () => {
        const all = SMOKE_DASHBOARDS.map((dashboard) => dashboard.name);
        const names = (changed: string[]) => affectedDashboards(changed).map((dashboard) => dashboard.name);

        expect(names(["src/utils/logger/daily-trigger.ts"])).toEqual(all);
        expect(names(["bun.lock"])).toEqual(all);
        expect(names(["src/clarity/ui/src/routes/index.tsx"])).toEqual(["clarity"]);
        expect(names(["src/du/index.ts", "README.md"])).toEqual([]);
        expect(names(["src/youtube/extension/manifest.json"])).toEqual([]);
    });

    test("every listed dashboard has its Vite config", () => {
        expect(SMOKE_DASHBOARDS.filter((dashboard) => !existsSync(dashboard.config))).toEqual([]);
    });
});

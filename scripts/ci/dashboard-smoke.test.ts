import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { affectedDashboards, SMOKE_DASHBOARDS } from "./dashboard-smoke";

describe("dashboard-smoke", () => {
    const names = (changed: string[]) => affectedDashboards(changed).map((dashboard) => dashboard.name);

    test("shared code and package files reach every dashboard; a dashboard's own folder reaches only it", () => {
        const all = SMOKE_DASHBOARDS.map((dashboard) => dashboard.name);

        expect(names(["src/utils/logger/daily-trigger.ts"])).toEqual(all);
        expect(names(["bun.lock"])).toEqual(all);
        expect(names(["src/clarity/ui/src/routes/index.tsx"])).toEqual(["clarity"]);
        expect(names(["src/du/index.ts", "README.md"])).toEqual([]);
        expect(names(["src/youtube/extension/manifest.json"])).toEqual([]);
    });

    test("a change in another tool's folder that a dashboard imports reaches that dashboard", () => {
        expect(names(["src/azure-devops/config.ts"])).toEqual(["clarity"]);
        expect(names(["src/youtube/lib/config.ts"])).toEqual(["youtube"]);
        expect(names(["src/daemon/lib/launchd.ts"])).toEqual(["dev-dashboard", "shops"]);
    });

    test("every listed dashboard has its Vite config, and every @app import in its folder is under a root it lists", () => {
        expect(SMOKE_DASHBOARDS.filter((dashboard) => !existsSync(dashboard.config))).toEqual([]);

        const listed = spawnSync("git", ["ls-files", "--", ...SMOKE_DASHBOARDS.map((d) => d.folder)], {
            encoding: "utf8",
            env: process.env,
        });
        expect(listed.status).toBe(0);
        const sources = listed.stdout.split("\n").filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));

        const unlisted = SMOKE_DASHBOARDS.flatMap((dashboard) => {
            const files = sources.filter((file) => file.startsWith(dashboard.folder));
            expect(files.length).toBeGreaterThan(0);

            return files.flatMap((file) =>
                [...readFileSync(file, "utf8").matchAll(/["']@app\/([\w.-]+(?:\/[\w.-]+)*)["']/g)]
                    // `@app/yt` is youtube's alias for its own ui folder.
                    .filter(([, spec]) => spec !== "yt" && !spec.startsWith("yt/"))
                    .filter(
                        ([, spec]) =>
                            ![dashboard.folder, ...dashboard.uses].some((root) => `src/${spec}/`.startsWith(root))
                    )
                    .map(([, spec]) => `${dashboard.name}: ${file} imports @app/${spec}`)
            );
        });
        expect(unlisted).toEqual([]);
    });
});

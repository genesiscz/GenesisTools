import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import { isWatchedPreviewServerPath } from "./serverHot";

const FILE = { isFile: () => true } as Stats;
const DIR = { isFile: () => false } as Stats;

// The watched entries are whole directories (`src/dev-dashboard/lib`,
// `src/utils/macos`), and every event under them restarts the Vite preview.
// Restarting for a markdown edit or a build artefact is pure downtime.
describe("isWatchedPreviewServerPath", () => {
    test("non-test TypeScript under a watched dir still restarts the preview", () => {
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/front-proxy.ts", FILE)).toBe(true);
        expect(isWatchedPreviewServerPath("/repo/src/utils/macos/pulse.ts", FILE)).toBe(true);
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/ui/vite.config.ts", FILE)).toBe(true);
    });

    test("tests never restart the preview", () => {
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/front-proxy.test.ts", FILE)).toBe(false);
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/x.test.tsx", FILE)).toBe(false);
    });

    test("non-source files under a watched dir no longer restart the preview", () => {
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/README.md", FILE)).toBe(false);
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/fixture.json", FILE)).toBe(false);
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/shot.png", FILE)).toBe(false);
    });

    test("noise directories are pruned", () => {
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/node_modules/x/i.ts", FILE)).toBe(false);
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/dist/bundle.ts", FILE)).toBe(false);
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib/dist", DIR)).toBe(false);
    });

    test("directories stay watched — filtering them out would watch nothing", () => {
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib", DIR)).toBe(true);
        expect(isWatchedPreviewServerPath("/repo/src/utils/macos", DIR)).toBe(true);
        // chokidar hands the initial scan no stats at all; never prune then.
        expect(isWatchedPreviewServerPath("/repo/src/dev-dashboard/lib")).toBe(true);
    });
});

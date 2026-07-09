import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetBoardsDb } from "@app/dev-dashboard/lib/boards/db";
import { resetEventHub } from "@app/dev-dashboard/lib/boards/events";
import { __resetLayoutDebounce } from "@app/dev-dashboard/lib/boards/layout-engine";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@app/utils/env";

/** Shared per-test board DB fixture (mkdtemp'd home + in-memory db, reset on both ends). */
export function setupBoardsTestEnv(prefix: string): void {
    let dir = "";

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), prefix));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        env.testing.set("BOARDS_DB_PATH", ":memory:");
        resetDevDashboardStorage();
        resetBoardsDb();
        resetEventHub();
    });

    afterEach(() => {
        __resetLayoutDebounce();
        resetEventHub();
        resetBoardsDb();
        resetDevDashboardStorage();
        env.testing.unset("GENESIS_TOOLS_HOME");
        env.testing.unset("BOARDS_DB_PATH");
        rmSync(dir, { recursive: true, force: true });
    });
}

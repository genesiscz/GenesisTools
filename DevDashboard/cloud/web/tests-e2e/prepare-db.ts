/**
 * Resets the throwaway e2e SQLite file (guarded to the `.e2e/` path) and runs `db:migrate` against it.
 *
 * This MUST run before the dev server opens the DB. Playwright starts the `webServer` plugin BEFORE
 * `globalSetup` (verified in playwright/lib/runner: createPluginSetupTasks precede globalSetups), so
 * migrating in globalSetup races the server's first signup ("no such table: user"). Chaining this
 * script into the webServer command (`bun run tests-e2e/prepare-db.ts && bun run dev`) guarantees the
 * DB is migrated before the same server process opens it.
 *
 * Test-harness-only: never imported by app source. `rmSync` is scoped strictly to the test DB path.
 */

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

function assertTestDbPath(url: string | undefined): string {
    if (!url) {
        throw new Error("DD_CLOUD_DATABASE_URL must be set to the throwaway test DB path before prepare-db.");
    }

    if (url === ":memory:") {
        throw new Error("The e2e DB must be a real file (a :memory: DB 500s on signup); got ':memory:'.");
    }

    const abs = isAbsolute(url) ? url : resolve(process.cwd(), url);

    if (!abs.includes(`${sep}.e2e${sep}`)) {
        throw new Error(`Refusing to reset a DB outside the test-only .e2e/ dir: ${abs}`);
    }

    return abs;
}

const dbPath = assertTestDbPath(process.env.DD_CLOUD_DATABASE_URL);

for (const suffix of ["", "-wal", "-shm"]) {
    try {
        rmSync(`${dbPath}${suffix}`, { force: true });
    } catch (err) {
        console.warn(`[e2e] could not remove ${dbPath}${suffix}:`, err);
    }
}

execSync("bun run db:migrate", {
    stdio: "inherit",
    env: { ...process.env, DD_CLOUD_DATABASE_URL: dbPath },
});

console.log(`[e2e] migrated throwaway test DB: ${dbPath}`);

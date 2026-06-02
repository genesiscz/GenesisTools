import { test as base, expect } from "@playwright/test";

/**
 * Shared test entrypoint. Import `{ test, expect }` from here (not directly from
 * @playwright/test) so we can grow shared fixtures in ONE place later.
 *
 * No auth fixture is needed: the server auth bypass makes every request the
 * `dev-user`, so tests just navigate. Each spec resets the tables it owns in a
 * beforeEach (see support/db.ts `resetTables`).
 */
export const test = base;
export { expect };

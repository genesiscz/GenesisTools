import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { ensureExtensionCapableSQLite, resetSqliteVecState } from "./sqlite-vec-loader";

const HOMEBREW_DYLIB = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
const RUN_ORDERING_TESTS = process.platform === "darwin" && existsSync(HOMEBREW_DYLIB);

const LOADER_PATH = join(import.meta.dir, "sqlite-vec-loader.ts");
const PRELOAD_PATH = join(import.meta.dir, "sqlite-vec-preload.ts");

async function runFixture(source: string, preload?: string): Promise<{ stdout: string; exitCode: number }> {
    const dir = mkdtempSync(join(tmpdir(), "vec-loader-"));
    const fixturePath = join(dir, "fixture.ts");

    await Bun.write(fixturePath, source);

    try {
        const args = preload ? ["--preload", preload, fixturePath] : ["run", fixturePath];
        const proc = Bun.spawn(["bun", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { stdout, exitCode };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function parseLastStdoutLine(stdout: string): unknown {
    return SafeJSON.parse(stdout.trim().split("\n").at(-1) ?? "");
}

const FIXTURE_DATABASE_FIRST = `
import { Database } from "bun:sqlite";
import { ensureExtensionCapableSQLite, loadSqliteVec } from ${SafeJSON.stringify(LOADER_PATH)};
new Database(":memory:");
ensureExtensionCapableSQLite();
const db = new Database(":memory:");
console.log(\`{"loaded":\${loadSqliteVec(db) ? "true" : "false"}}\`);
`;

const FIXTURE_ENSURE_FIRST = `
import { Database } from "bun:sqlite";
import { ensureExtensionCapableSQLite, loadSqliteVec } from ${SafeJSON.stringify(LOADER_PATH)};
ensureExtensionCapableSQLite();
const db = new Database(":memory:");
console.log(\`{"loaded":\${loadSqliteVec(db) ? "true" : "false"}}\`);
`;

describe("sqlite-vec-loader ordering", () => {
    it.skipIf(!RUN_ORDERING_TESTS)(
        "loadSqliteVec returns false when a Database is constructed before the swap",
        async () => {
            const { stdout, exitCode } = await runFixture(FIXTURE_DATABASE_FIRST);

            expect(exitCode).toBe(0);
            expect(parseLastStdoutLine(stdout)).toEqual({ loaded: false });
        }
    );

    it.skipIf(!RUN_ORDERING_TESTS)("loadSqliteVec returns true when the swap runs before any Database", async () => {
        const { stdout, exitCode } = await runFixture(FIXTURE_ENSURE_FIRST);

        expect(exitCode).toBe(0);
        expect(parseLastStdoutLine(stdout)).toEqual({ loaded: true });
    });

    it.skipIf(!RUN_ORDERING_TESTS)(
        "sqlite-vec-preload.ts defeats the ordering trap: Database-first still loads",
        async () => {
            const { stdout, exitCode } = await runFixture(FIXTURE_DATABASE_FIRST, PRELOAD_PATH);

            expect(exitCode).toBe(0);
            expect(parseLastStdoutLine(stdout)).toEqual({ loaded: true });
        }
    );
});

describe("ensureExtensionCapableSQLite is a process-global one-shot", () => {
    afterEach(() => {
        resetSqliteVecState();
    });

    // Regression for the double-preload WARN: the `tools` launcher passes
    // sqlite-vec-preload via an absolute --preload path while bunfig.toml also
    // preloads it by relative path. Bun keys its module cache by specifier, so
    // the loader was instantiated twice and a module-level `let` guard let the
    // second instance call the process-global one-shot `setCustomSQLite()` a
    // second time -> "SQLite already loaded" -> 15-27 spurious WARN/day (prod
    // log pid 12002: `swapped` debug + `setCustomSQLite failed` warn in ONE
    // pid). The guard now lives on globalThis, shared across module instances.
    it("calls Database.setCustomSQLite at most once across repeated calls", () => {
        resetSqliteVecState();
        const spy = spyOn(Database, "setCustomSQLite").mockReturnValue(true);

        try {
            ensureExtensionCapableSQLite();
            const afterFirst = spy.mock.calls.length;

            ensureExtensionCapableSQLite();
            ensureExtensionCapableSQLite();
            const afterRepeats = spy.mock.calls.length;

            // The first call may invoke it 0 (non-darwin / no dylib) or 1
            // (darwin + Homebrew) times; the invariant under test is that
            // subsequent calls -- the duplicate module instances -- add none.
            expect(afterFirst).toBeLessThanOrEqual(1);
            expect(afterRepeats).toBe(afterFirst);
        } finally {
            spy.mockRestore();
        }
    });

    // This is the assertion that actually distinguishes the fix from the
    // broken code: a module-LEVEL `let` guard is invisible to a second module
    // instance (the duplicate preload). The guard MUST live on a process-global
    // object under a stable key so every instance shares it. Pre-fix there was
    // no such global -> this fails; that is the regression sentinel.
    it("persists the one-shot guard on a process-global Symbol (shared across module instances)", () => {
        resetSqliteVecState();
        const STATE_KEY = Symbol.for("genesis-tools.sqlite-vec.loader-state");

        expect((globalThis as Record<symbol, unknown>)[STATE_KEY]).toBeUndefined();

        ensureExtensionCapableSQLite();

        const shared = (globalThis as Record<symbol, unknown>)[STATE_KEY] as
            | { customSqliteAttempted: boolean }
            | undefined;

        // A second module instance only has `globalThis` -- not this module's
        // closure -- so this is exactly what its guard check would see.
        expect(shared).toBeDefined();
        expect(shared?.customSqliteAttempted).toBe(true);
    });
});

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";

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

    it.skipIf(!RUN_ORDERING_TESTS)(
        "loadSqliteVec returns true when the swap runs before any Database",
        async () => {
            const { stdout, exitCode } = await runFixture(FIXTURE_ENSURE_FIRST);

            expect(exitCode).toBe(0);
            expect(parseLastStdoutLine(stdout)).toEqual({ loaded: true });
        }
    );

    it.skipIf(!RUN_ORDERING_TESTS)(
        "sqlite-vec-preload.ts defeats the ordering trap: Database-first still loads",
        async () => {
            const { stdout, exitCode } = await runFixture(FIXTURE_DATABASE_FIRST, PRELOAD_PATH);

            expect(exitCode).toBe(0);
            expect(parseLastStdoutLine(stdout)).toEqual({ loaded: true });
        }
    );
});

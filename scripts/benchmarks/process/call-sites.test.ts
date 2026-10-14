import { describe, expect, spyOn, test } from "bun:test";
import { scanProcessToolSpawns } from "../../ci/lint-rules";
import { CALL_SITES, checkValue, isProcessToolSpawn, runsHere } from "./call-sites";

/*
 * The contract of the ps / lsof / pgrep migration, one test per call site. Each site must reach its answer without
 * starting ps, lsof or pgrep: the platform decision (kernel read, /proc, CIM, or one batched fallback) belongs to
 * `@genesiscz/utils/process`, never to the caller. A site still listed in `scripts/ci/process-tool-spawn-baseline.ts`
 * is expected to fail here; the migration makes it pass and lowers the baseline in the same commit.
 */

const trackedSources = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], { stdout: "pipe", env: process.env })
    .stdout.toString()
    .trim()
    .split("\n");

describe("the call-site registry", () => {
    test("covers every spawn the lint rule finds, file by file", async () => {
        const registered = new Map<string, number>();

        for (const site of CALL_SITES) {
            registered.set(site.file, (registered.get(site.file) ?? 0) + (site.findings ?? 1));
        }

        const found = new Map<string, number>();

        for (const finding of await scanProcessToolSpawns(trackedSources)) {
            found.set(finding.file, (found.get(finding.file) ?? 0) + 1);
        }

        // A spawn that moved into the process layer leaves the lint findings; its entry stays as the benchmark of
        // the caller, so the registry may cover more than the rule finds, never less.
        expect(found.size).toBeGreaterThan(0);
        const uncovered = [...found]
            .filter(([file, count]) => (registered.get(file) ?? 0) < count)
            .map(([file, count]) => `${file}: ${count} found, ${registered.get(file) ?? 0} registered`);
        expect(uncovered).toEqual([]);
    });

    test("ids are unique kebab-case", () => {
        const ids = CALL_SITES.map((site) => site.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([]);
    });

    test("isProcessToolSpawn reads the program and the first word of sh -c", () => {
        expect(isProcessToolSpawn(["/bin/ps", "-ax"])).toBe(true);
        expect(isProcessToolSpawn(["lsof", "-nP"])).toBe(true);
        expect(isProcessToolSpawn(["sh", "-c", "pgrep -x Brave"])).toBe(true);
        expect(isProcessToolSpawn(["git", "ps"])).toBe(false);
        expect(isProcessToolSpawn(["sh", "-c", "echo ps"])).toBe(false);
    });

    test("checkValue counts what a caller uses", () => {
        expect(checkValue([1, 2, 3])).toBe(3);
        expect(checkValue(new Map([[1, 2]]))).toBe(1);
        expect(checkValue(null)).toBe(0);
        expect(checkValue("")).toBe(0);
        expect(checkValue({ pid: 1 })).toBe(1);
        expect(checkValue(1791936048010)).toBe(1);
    });
});

interface ToolSpawn {
    cmd: string[];
    /** True when a frame of the call stack is in the process layer, which owns every remaining fallback. */
    fromLayer: boolean;
}

type AnySpawn = (...args: unknown[]) => unknown;

function argvOf(args: unknown[]): string[] {
    const first = args[0];

    if (Array.isArray(first)) {
        return first.map(String);
    }

    const cmd = typeof first === "object" && first !== null && "cmd" in first ? first.cmd : undefined;
    return Array.isArray(cmd) ? cmd.map(String) : [];
}

/**
 * Every ps, lsof or pgrep `run` starts, with whether the process layer started it. Every `node:child_process` entry
 * point funnels into `Bun.spawn` or `Bun.spawnSync` on Bun, so the two spies see every spawn but `Bun.$`.
 */
async function toolSpawns(run: () => unknown): Promise<ToolSpawn[]> {
    const found: ToolSpawn[] = [];
    const original = { spawn: Bun.spawn as unknown as AnySpawn, spawnSync: Bun.spawnSync as unknown as AnySpawn };

    function record(args: unknown[]): void {
        const cmd = argvOf(args);

        if (isProcessToolSpawn(cmd)) {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 200;
            const stack = new Error().stack ?? "";
            Error.stackTraceLimit = limit;
            found.push({ cmd, fromLayer: stack.includes("/src/utils/process/") });
        }
    }

    const spawn = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
        record(args);
        return original.spawn(...args);
    }) as unknown as typeof Bun.spawn);
    const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(((...args: unknown[]) => {
        record(args);
        return original.spawnSync(...args);
    }) as unknown as typeof Bun.spawnSync);

    try {
        await run();
    } finally {
        spawn.mockRestore();
        spawnSync.mockRestore();
    }

    return found;
}

/**
 * A stand-in is the bare spawn by definition, so it fails until the migration extracts a read-only reader from the
 * site, points the entry's `run` at it and drops `standIn`.
 */
describe("no call site starts ps, lsof or pgrep itself", () => {
    for (const site of CALL_SITES) {
        test.skipIf(!runsHere(site))(
            `${site.id} (${site.file})`,
            async () => {
                const spawns = await toolSpawns(site.run);
                // The caller never decides on a fallback; the process layer does, within the site's budget.
                expect(spawns.filter((spawn) => !spawn.fromLayer).map((spawn) => spawn.cmd)).toEqual([]);
                expect(spawns.length).toBeLessThanOrEqual(site.budget?.spawns ?? 0);
            },
            30_000
        );
    }
});

test("the stack check tells a layer spawn from a caller's own", async () => {
    const { readProcess } = await import("@genesiscz/utils/process/processes");
    const own = await toolSpawns(() =>
        Bun.spawnSync(["ps", "-p", String(process.pid)], { stdout: "pipe", env: process.env })
    );
    expect(own.map((spawn) => spawn.fromLayer)).toEqual([false]);
    const layer = await toolSpawns(() => readProcess(1, { otherUsers: true }));
    expect(layer.every((spawn) => spawn.fromLayer)).toBe(true);
});

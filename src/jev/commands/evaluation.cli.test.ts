import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const entry = join(import.meta.dir, "..", "index.ts");
const homes: string[] = [];

afterEach(() => {
    for (const home of homes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
    }
});

async function runCli(home: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(["bun", entry, ...args], {
        env: { ...process.env, GENESIS_TOOLS_HOME: home, TERM: "dumb" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 30_000);

    try {
        const [stdout, stderr, status] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { status, stdout, stderr };
    } finally {
        clearTimeout(deadline);
    }
}

function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "jev-eval-cli-"));
    homes.push(home);
    return home;
}

describe("tools jev evaluation CLI", () => {
    test("create list show run rm are two-channel (stdout + disk)", async () => {
        const home = tempHome();
        const programsDir = join(home, ".genesis-tools", "jev", "probably", "programs");

        const created = await runCli(home, ["evaluation", "create", "--name", "hello", "--bundle", "hello"]);
        expect(created.status, created.stderr).toBe(0);
        const saved = SafeJSON.parse(created.stdout) as { saved: { name: string; path: string } };
        expect(saved.saved.name).toBe("hello");
        expect(existsSync(join(programsDir, "hello.prob"))).toBe(true);
        expect(readFileSync(join(programsDir, "hello.prob"), "utf8")).toContain("Hello, uncertainty.");

        const listed = await runCli(home, ["evaluation", "list", "--json"]);
        expect(listed.status, listed.stderr).toBe(0);
        const list = SafeJSON.parse(listed.stdout) as { programs: Array<{ name: string }> };
        expect(list.programs.map((p) => p.name)).toEqual(["hello"]);

        const shown = await runCli(home, ["evaluation", "show", "hello"]);
        expect(shown.status, shown.stderr).toBe(0);
        expect(shown.stdout).toContain("Hello, uncertainty.");

        const ran = await runCli(home, ["evaluation", "run", "hello"]);
        expect(ran.status, ran.stderr).toBe(0);
        const result = SafeJSON.parse(ran.stdout) as { output: string[]; tape: unknown[] };
        expect(result.output[0]).toBe("Hello, uncertainty.");
        expect(result.tape).toEqual([]);

        const removed = await runCli(home, ["evaluation", "rm", "hello"]);
        expect(removed.status, removed.stderr).toBe(0);
        expect(existsSync(join(programsDir, "hello.prob"))).toBe(false);

        const listedAfter = await runCli(home, ["evaluation", "list", "--json"]);
        expect(listedAfter.status, listedAfter.stderr).toBe(0);
        expect((SafeJSON.parse(listedAfter.stdout) as { programs: unknown[] }).programs).toEqual([]);
    }, 60_000);

    test("evaluation --help lists create and run", async () => {
        const home = tempHome();
        const help = await runCli(home, ["evaluation", "--help"]);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("create");
        expect(help.stdout).toContain("run");
        expect(help.stdout).toContain("rm");
    }, 30_000);
});

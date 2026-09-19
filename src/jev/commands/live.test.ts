import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "index.ts");

interface HelpResult {
    status: number | null;
    stdout: string;
}

/**
 * One `--help` child per command, all started at once: nine sequential spawns at ~0.4 s each
 * sat right on the 5 s per-test ceiling and timed out on the CI runner (run 35358885621).
 */
async function help(args: string[]): Promise<HelpResult> {
    const child = Bun.spawn(["bun", entry, ...args, "--help"], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 30_000);
    try {
        const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { status, stdout };
    } finally {
        clearTimeout(deadline);
    }
}

const EXPECTED: Array<{ args: string[]; flags: string[] }> = [
    { args: ["listen"], flags: ["--stt", "--transcript", "--dry-run", "--from-wake", "--surface"] },
    { args: ["route"], flags: ["--run", "--suggest"] },
    { args: ["compact"], flags: ["--llm", "--keep", "--keep-tokens", "--source"] },
    { args: ["screen"], flags: ["--purpose"] },
    { args: ["watch"], flags: ["--hz"] },
    { args: ["loop"], flags: ["--browser", "--surface"] },
    { args: ["wake"], flags: ["status"] },
    { args: ["control", "assist"], flags: ["--no-fanout"] },
    { args: ["control", "demo"], flags: ["--i-mean-it"] },
    { args: ["evaluation"], flags: ["create", "run", "list", "rm"] },
];

test("live policy commands advertise their flags", async () => {
    const results = await Promise.all(EXPECTED.map((entry) => help(entry.args)));
    for (const [index, expected] of EXPECTED.entries()) {
        const result = results[index];
        expect(result.status, expected.args.join(" ")).toBe(0);
        for (const flag of expected.flags) {
            expect(result.stdout, `${expected.args.join(" ")} lacks ${flag}`).toContain(flag);
        }
    }
}, 20_000);

test("non-TTY listen without --transcript exits 1", () => {
    const result = spawnSync("bun", [entry, "listen", "--stt", "fixture"], {
        env: { ...process.env, TERM: "dumb" },
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--transcript");
});
